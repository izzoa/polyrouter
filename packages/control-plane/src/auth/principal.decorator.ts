import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { Principal } from '@polyrouter/shared/server';
import type { Request } from 'express';

/** Marks a route as needing no session (health, the auth routes). */
export const PUBLIC_KEY = 'polyrouter:public';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);

export interface AuthedRequest extends Request {
  principal?: Principal;
}

/** Injects the resolved tenant principal (set by SessionGuard). */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.principal) throw new Error('CurrentPrincipal used on an unguarded route');
    return req.principal;
  },
);
