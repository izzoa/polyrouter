import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  PERSISTENCE_PORT,
  REDIS_CLIENT,
  assertAppriseTargetSafe,
  assertNetworkHostSafe,
  decryptSecret,
  encryptSecret,
  type NotificationChannelPatch,
  type NotificationChannelRow,
  type PersistencePort,
  type Principal,
} from '@polyrouter/shared/server';
import { AuthRateLimiter, type RateRule } from '../auth/rate-limit';
import {
  parseStoredConfig,
  validateChannelConfig,
  type AppriseConfig,
  type ChannelConfig,
  type SmtpConfig,
} from './channel-config';
import { NOTIFY_RUNTIME, type NotifyRuntime } from './notify.config';
import { renderEvent } from './notification.types';
import { deliverApprise } from './delivery/apprise.adapter';
import { deliverSmtp } from './delivery/smtp.adapter';
import type { CreateChannelDto, UpdateChannelDto } from './channels.dto';

const TEST_SEND_TIMEOUT_MS = 15_000;

// Per-user throttle on the test-send route (E14.2): it drives a real SMTP session
// / Apprise POST + live DNS, so an authenticated (or stolen) session must not loop
// it to spam recipients or hammer the sidecar. A few per minute is plenty for a UI
// "send test" button; the shared window limiter counts globally across instances.
const NOTIFY_TEST_RATE: RateRule = { prefix: 'test-send', max: 5, windowSec: 60, keyspace: 'notify' };

/** The API-safe view of a channel — never the decrypted config. */
export interface SafeChannel {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  eventsSubscribed: string[];
  hasConfig: boolean;
  lastTestAt: Date | null;
  lastTestStatus: string | null;
}

function toSafe(r: NotificationChannelRow): SafeChannel {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    enabled: r.enabled,
    eventsSubscribed: r.eventsSubscribed ? r.eventsSubscribed.split(',') : [],
    hasConfig: r.encryptedConfig.length > 0,
    lastTestAt: r.lastTestAt,
    lastTestStatus: r.lastTestStatus,
  };
}

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);
  private readonly testLimiter: AuthRateLimiter;
  private testLimiterRedisWarned = false;

  constructor(
    @Inject(PERSISTENCE_PORT) private readonly db: PersistencePort,
    @Inject(NOTIFY_RUNTIME) private readonly rt: NotifyRuntime,
    @Inject(REDIS_CLIENT) redis: Redis,
  ) {
    // Latch the degradation warning to once per process (a Redis outage otherwise
    // logs on EVERY test-send, including throttled ones — log amplification during
    // the outage). The limiter itself keeps enforcing via its per-instance fallback.
    this.testLimiter = new AuthRateLimiter(redis, () => {
      if (this.testLimiterRedisWarned) return;
      this.testLimiterRedisWarned = true;
      this.logger.warn('test-send rate limiter: Redis unavailable — per-instance fallback active');
    });
  }

  async list(principal: Principal): Promise<SafeChannel[]> {
    return (await this.db.notificationChannels.list(principal)).map(toSafe);
  }

  async get(principal: Principal, id: string): Promise<SafeChannel> {
    const row = await this.db.notificationChannels.findById(principal, id);
    if (row === null) throw new NotFoundException();
    return toSafe(row);
  }

  async create(principal: Principal, dto: CreateChannelDto): Promise<SafeChannel> {
    const config = validateChannelConfig(dto.kind, dto.config);
    this.gateCloudApprise(dto.kind);
    await this.assertConfigSafe(dto.kind, config);
    const row = await this.db.notificationChannels.insert(principal, {
      name: dto.name,
      kind: dto.kind,
      enabled: dto.enabled ?? true,
      encryptedConfig: encryptSecret(JSON.stringify(config), this.rt.notifySecret),
      eventsSubscribed: (dto.eventsSubscribed ?? []).join(','),
      lastTestAt: null,
      lastTestStatus: null,
    });
    return toSafe(row);
  }

  async update(principal: Principal, id: string, dto: UpdateChannelDto): Promise<SafeChannel> {
    const existing = await this.db.notificationChannels.findById(principal, id);
    if (existing === null) throw new NotFoundException();
    const kind = dto.kind ?? existing.kind;
    if (dto.kind !== undefined && dto.kind !== existing.kind && dto.config === undefined) {
      throw new UnprocessableEntityException('changing kind requires a new config');
    }
    const patch: NotificationChannelPatch = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.enabled !== undefined) patch.enabled = dto.enabled;
    if (dto.eventsSubscribed !== undefined) patch.eventsSubscribed = dto.eventsSubscribed.join(',');
    if (dto.kind !== undefined) patch.kind = dto.kind;
    if (dto.config !== undefined) {
      const config = validateChannelConfig(kind, dto.config); // empty/invalid → 422
      this.gateCloudApprise(kind);
      await this.assertConfigSafe(kind, config);
      patch.encryptedConfig = encryptSecret(JSON.stringify(config), this.rt.notifySecret);
      // The prior test result was for the OLD config — clear it so the UI doesn't show
      // a stale "success" for a target/credentials that changed (A-34).
      patch.lastTestStatus = null;
      patch.lastTestAt = null;
    }
    const row = await this.db.notificationChannels.update(principal, id, patch);
    if (row === null) throw new NotFoundException();
    return toSafe(row);
  }

  async remove(principal: Principal, id: string): Promise<{ deleted: boolean }> {
    const deleted = await this.db.notificationChannels.remove(principal, id);
    if (!deleted) throw new NotFoundException();
    return { deleted };
  }

  /** Deliver a test event directly (bypass the queue) for inline feedback;
   * persist a sanitized `last_test_status`. */
  async testSend(principal: Principal, id: string): Promise<{ ok: boolean; error?: string }> {
    // Throttle BEFORE any DNS/SMTP/Apprise work, keyed per user across all their
    // channels, so a loop can't spam recipients or tie up the sidecar (E14.2).
    const decision = await this.testLimiter.check(ownerOf(principal), NOTIFY_TEST_RATE, Date.now());
    if (!decision.allowed) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: 'too many test-sends — please retry shortly',
          retryAfterSec: decision.retryAfterSec,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const row = await this.db.notificationChannels.findById(principal, id);
    if (row === null) throw new NotFoundException();
    const config = parseStoredConfig(
      row.kind,
      decryptSecret(row.encryptedConfig, this.rt.notifySecret),
    );
    const rendered = renderEvent({
      type: 'test',
      scope: { ownerUserId: ownerOf(principal) },
      fields: { channelName: row.name },
    });
    let ok = true;
    let error: string | undefined;
    try {
      if (row.kind === 'smtp')
        await deliverSmtp(config as SmtpConfig, rendered, this.rt, TEST_SEND_TIMEOUT_MS);
      else await deliverApprise(config as AppriseConfig, rendered, this.rt, TEST_SEND_TIMEOUT_MS);
    } catch (e) {
      ok = false;
      error = (e as Error).message; // already a sanitized code
    }
    await this.db.notificationChannels.update(principal, id, {
      lastTestAt: new Date(),
      lastTestStatus: ok ? 'success' : `failed:${error}`,
    });
    return { ok, ...(error !== undefined ? { error } : {}) };
  }

  private gateCloudApprise(kind: string): void {
    if (kind === 'apprise' && this.rt.mode === 'cloud' && !this.rt.appriseEgressConfirmed) {
      throw new UnprocessableEntityException(
        'apprise channels require confirmed sidecar egress isolation in cloud mode',
      );
    }
  }

  private async assertConfigSafe(kind: string, config: ChannelConfig): Promise<void> {
    const opts = { mode: this.rt.mode, allowedEndpoints: this.rt.allowedEndpoints };
    try {
      if (kind === 'smtp') {
        const c = config as SmtpConfig;
        await assertNetworkHostSafe(c.host, c.port, opts);
      } else {
        for (const url of (config as AppriseConfig).urls) await assertAppriseTargetSafe(url, opts);
      }
    } catch {
      throw new UnprocessableEntityException('notification target failed SSRF validation');
    }
  }
}

function ownerOf(principal: Principal): string {
  return principal.kind === 'user' ? principal.userId : principal.orgId;
}
