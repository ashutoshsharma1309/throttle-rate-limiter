/**
 * Typed service errors. Each carries an HTTP status + gRPC code so the two
 * transports map outcomes consistently without duplicating the policy.
 */
import * as grpc from "@grpc/grpc-js";

export abstract class ServiceError extends Error {
  abstract readonly httpStatus: number;
  abstract readonly grpcCode: grpc.status;
  abstract readonly code: string;
}

export class UnknownApiKeyError extends ServiceError {
  readonly httpStatus = 401;
  readonly grpcCode = grpc.status.UNAUTHENTICATED;
  readonly code = "UNKNOWN_API_KEY";
  constructor() {
    super("Missing or unknown API key");
  }
}

export class AdminForbiddenError extends ServiceError {
  readonly httpStatus = 403;
  readonly grpcCode = grpc.status.PERMISSION_DENIED;
  readonly code = "ADMIN_FORBIDDEN";
  constructor() {
    super("Admin API key required");
  }
}

export class UnknownTenantError extends ServiceError {
  readonly httpStatus = 404;
  readonly grpcCode = grpc.status.NOT_FOUND;
  readonly code = "UNKNOWN_TENANT";
  constructor(tenantId: string) {
    super(`No such tenant: ${tenantId}`);
  }
}

export class UnknownRuleError extends ServiceError {
  readonly httpStatus = 404;
  readonly grpcCode = grpc.status.NOT_FOUND;
  readonly code = "UNKNOWN_RULE";
  constructor(ruleId: string) {
    super(`No rule "${ruleId}" for this tenant`);
  }
}

export class InvalidRequestError extends ServiceError {
  readonly httpStatus = 400;
  readonly grpcCode = grpc.status.INVALID_ARGUMENT;
  readonly code = "INVALID_REQUEST";
  constructor(message: string) {
    super(message);
  }
}

/** Redis unreachable AND fail mode is closed — request rejected. (M5) */
export class BackendUnavailableError extends ServiceError {
  readonly httpStatus = 503;
  readonly grpcCode = grpc.status.UNAVAILABLE;
  readonly code = "BACKEND_UNAVAILABLE";
  constructor() {
    super("Rate limit backend unavailable");
  }
}
