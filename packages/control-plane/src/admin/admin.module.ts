import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { MailerModule } from '../producers/mailer.module';
import { AdminController } from './admin.controller';

/** Admin user management (user-administration). Deliberately imports only the
 * identity-plane modules — NOT the tenant PersistencePort — so this module
 * physically cannot reach another user's tenant data (invariant 5). */
@Module({
  imports: [DatabaseModule, MailerModule, AuthModule],
  controllers: [AdminController],
})
export class AdminModule {}
