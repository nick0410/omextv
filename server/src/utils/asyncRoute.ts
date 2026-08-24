import { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Hand an async handler's failure to Express.
 *
 * Express 4 calls a handler and ignores what it returns, so a rejected promise
 * reaches nothing: the error handler never runs, no response is ever written,
 * and the request hangs until the client gives up. The only evidence is an
 * unhandledRejection in the log, long after the user has left.
 *
 * Every other router here guards against that with a try/catch in each
 * handler. This is the same thing said once — and unlike a per-handler catch,
 * it cannot be forgotten when a new route is added, which is exactly how the
 * coin routes ended up with ten async handlers and no error handling at all.
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
