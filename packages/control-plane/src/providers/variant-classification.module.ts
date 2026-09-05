import { Module } from '@nestjs/common';
import { DatabaseMaintenanceModule } from '../database/maintenance.module';
import { VariantClassificationBootstrap } from './variant-classification.bootstrap';

/** The boot classification pass's own module: controller-free, so it may import
 * the persistence module's maintenance half (tenant-isolation: request-handling
 * modules never do). */
@Module({
  imports: [DatabaseMaintenanceModule],
  providers: [VariantClassificationBootstrap],
})
export class VariantClassificationModule {}
