import {
  BadRequestException,
  Body,
  Controller,
  Header,
  Inject,
  Post,
  Res,
} from '@nestjs/common';
import { IsString, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { IDENTITY_PORT, type IdentityPort } from '@polyrouter/shared/server';
import { Public } from './principal.decorator';
import { AUTH_INSTANCE } from './auth.tokens';
import type { AuthInstance } from './better-auth';
import { hashInviteToken, isPlausibleInviteToken } from './invite-token';
import { runWithInviteBypass } from './signup-gate';

class AcceptInviteDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  // Better Auth's default minimum is 8 — validating BEFORE the claim keeps a
  // weak password from burning a valid invite.
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

/** Public invite acceptance (user-administration). The raw token arrives in
 * the POST body only (never a logged query); errors are UNIFORM for
 * invalid/expired/consumed/unknown so the endpoint enumerates nothing; the
 * dedicated per-IP rate rule throttles guessing. On success the Better Auth
 * session cookies are forwarded — the invitee lands signed in. */
@Controller('api/invites')
export class InvitesController {
  constructor(
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    @Inject(AUTH_INSTANCE) private readonly auth: AuthInstance,
  ) {}

  @Public()
  @Post('accept')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async accept(
    @Body() dto: AcceptInviteDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const uniform = (): BadRequestException =>
      new BadRequestException('invalid or expired invite');

    if (!isPlausibleInviteToken(dto.token)) throw uniform();

    // Atomic claim: exactly one accept can consume the invite.
    const claimed = await this.identity.userAdmin.claimInvite(hashInviteToken(dto.token));
    if (!claimed) throw uniform();

    try {
      const { headers } = await runWithInviteBypass(claimed.email, () =>
        this.auth.signUpEmailWithHeaders({
          name: dto.name,
          email: claimed.email,
          password: dto.password,
        }),
      );
      const cookies = headers.getSetCookie();
      if (cookies.length > 0) res.setHeader('set-cookie', cookies);
      return { ok: true };
    } catch {
      // Documented residual: the claim is consumed but creation failed (e.g.
      // the email already has an account). Honest, non-enumerating guidance —
      // the token WAS valid, so this isn't an oracle.
      throw new BadRequestException(
        'the account could not be created — ask your admin to re-issue the invite',
      );
    }
  }
}
