import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Enforces bearer token authentication for transport-facing HTTP requests.
 */
@Injectable()
export class BearerGuard implements CanActivate {
  /**
   * Validates the incoming authorization header against the configured agent token.
   *
   * @param context Execution context provided by NestJS for the current request.
   * @throws UnauthorizedException when the header is missing or does not match.
   * @returns True when the request should proceed.
   */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const authorizationHeader =
      typeof request.headers.authorization === 'string'
        ? request.headers.authorization
        : undefined;
    const providedToken = authorizationHeader?.startsWith('Bearer ')
      ? authorizationHeader.slice(7).trim()
      : undefined;

    const expectedToken = process.env.AGENT_AUTH_TOKEN;

    if (!expectedToken || expectedToken.length === 0) {
      return true;
    }

    if (providedToken && providedToken === expectedToken) {
      return true;
    }

    throw new UnauthorizedException('Invalid or missing token');
  }
}
