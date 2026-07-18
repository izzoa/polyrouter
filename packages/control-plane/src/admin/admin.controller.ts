import {
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { IsBoolean, IsEmail, IsIn } from 'class-validator';
import {
  IDENTITY_PORT,
  REGISTRATION_MODES,
  assertUserPrincipal,
  type AdminInviteRecord,
  type AdminUserRecord,
  type IdentityPort,
  type Principal,
  type RegistrationMode,
} from '@polyrouter/shared/server';
import { InvitesService, type IssuedInvite } from '../auth/invites.service';
import { CurrentPrincipal } from '../auth/principal.decorator';
import { SystemMailer } from '../producers/system-mailer';

class CreateInviteDto {
  @IsEmail()
  email!: string;
}

class SetRoleDto {
  @IsIn(['admin', null])
  role!: 'admin' | null;
}

class SetDisabledDto {
  @IsBoolean()
  disabled!: boolean;
}

class SetRegistrationDto {
  @IsIn(REGISTRATION_MODES)
  mode!: RegistrationMode;
}

/** `/api/admin` (user-administration): the guest list, not the tenants. Every
 * endpoint re-verifies an ENABLED admin server-side and operates only over
 * user/invite/settings records via the narrow identity port — no tenant data
 * (agents/providers/logs) crosses this surface (invariant 5). `refused`
 * results are the last-enabled-admin guard → 409. */
@Controller('api/admin')
export class AdminController {
  constructor(
    @Inject(IDENTITY_PORT) private readonly identity: IdentityPort,
    private readonly invites: InvitesService,
    private readonly mailer: SystemMailer,
  ) {}

  @Get('users')
  async listUsers(@CurrentPrincipal() p: Principal): Promise<AdminUserRecord[]> {
    await this.requireAdmin(p);
    return this.identity.userAdmin.listUsers();
  }

  @Patch('users/:id/role')
  async setRole(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() dto: SetRoleDto,
  ): Promise<{ ok: true }> {
    await this.requireAdmin(p);
    return this.outcome(await this.identity.userAdmin.setRole(id, dto.role));
  }

  @Patch('users/:id/disabled')
  async setDisabled(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() dto: SetDisabledDto,
  ): Promise<{ ok: true }> {
    await this.requireAdmin(p);
    return this.outcome(await this.identity.userAdmin.setDisabled(id, dto.disabled));
  }

  @Delete('users/:id')
  async deleteUser(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.requireAdmin(p);
    return this.outcome(await this.identity.userAdmin.deleteUser(id));
  }

  @Post('invites')
  @HttpCode(201)
  // The response body carries the raw one-time link — keep it out of caches.
  @Header('Cache-Control', 'no-store')
  async createInvite(
    @CurrentPrincipal() p: Principal,
    @Body() dto: CreateInviteDto,
  ): Promise<IssuedInvite> {
    await this.requireAdmin(p);
    assertUserPrincipal(p);
    return this.invites.issue(dto.email, p.userId);
  }

  @Get('invites')
  async listInvites(@CurrentPrincipal() p: Principal): Promise<AdminInviteRecord[]> {
    await this.requireAdmin(p);
    return this.identity.userAdmin.listInvites();
  }

  @Delete('invites/:id')
  async revokeInvite(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.requireAdmin(p);
    const revoked = await this.identity.userAdmin.revokeInvite(id);
    if (!revoked) throw new NotFoundException();
    return { ok: true };
  }

  @Get('settings/registration')
  async getRegistration(
    @CurrentPrincipal() p: Principal,
  ): Promise<{ mode: RegistrationMode; smtpConfigured: boolean }> {
    await this.requireAdmin(p);
    return {
      mode: await this.identity.userAdmin.getRegistrationMode(),
      smtpConfigured: this.mailer.configured,
    };
  }

  @Put('settings/registration')
  async setRegistration(
    @CurrentPrincipal() p: Principal,
    @Body() dto: SetRegistrationDto,
  ): Promise<{ mode: RegistrationMode }> {
    await this.requireAdmin(p);
    await this.identity.userAdmin.setRegistrationMode(dto.mode);
    return { mode: dto.mode };
  }

  private async requireAdmin(principal: Principal): Promise<void> {
    assertUserPrincipal(principal);
    if (!(await this.identity.isAdmin(principal.userId))) {
      throw new ForbiddenException('admin required');
    }
  }

  private outcome(result: 'ok' | 'refused' | 'not_found'): { ok: true } {
    if (result === 'not_found') throw new NotFoundException();
    if (result === 'refused') {
      throw new ConflictException(
        'refused: this would leave the instance without an enabled admin',
      );
    }
    return { ok: true };
  }
}
