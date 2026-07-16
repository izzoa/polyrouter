import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccountController } from './account.controller';
import '../auth/auth.config'; // register the auth config schema so login-config can read it

/** Dashboard identity/login-bootstrap endpoints (#18). Reads `IDENTITY_PORT`
 * (from `DatabaseModule`) + config; no persistence surface of its own. */
@Module({
  imports: [DatabaseModule],
  controllers: [AccountController],
})
export class AccountModule {}
