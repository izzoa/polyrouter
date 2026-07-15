import { Module } from '@nestjs/common';

/**
 * The inference-proxy module. Empty in the foundation change — the proxy
 * endpoints, routing pipeline, and recording land in later changes (TODOS.md
 * #10+). It exists now so the package boundary is real from day one and the
 * cloud-tier extraction (spec §3.3) stays a deploy change, not a rewrite.
 */
@Module({})
export class DataPlaneModule {}
