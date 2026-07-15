import { Module } from '@nestjs/common';
import { DataPlaneModule } from '@polyrouter/data-plane';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [DatabaseModule, RedisModule, DataPlaneModule],
  controllers: [HealthController],
})
export class AppModule {}
