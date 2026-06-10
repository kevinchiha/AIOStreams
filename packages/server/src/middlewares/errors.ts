import { Request, Response, NextFunction } from 'express';
import {
  createLogger,
  APIError,
  constants,
  StremioTransformer,
} from '@aiostreams/core';
import { createResponse } from '../utils/responses.js';
import { STREMIO_RESOURCE_REQUEST_REGEX } from '../utils/stremioResourceUrl.js';
import { ZodError } from 'zod';

const logger = createLogger('server');

export const errorMiddleware = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!err) {
    next();
    return;
  }

  let error;
  if (!(err instanceof APIError) && !(err instanceof ZodError)) {
    // log unexpected errors
    logger.error(err);
    logger.error(err.stack);
    error = new APIError(constants.ErrorCode.INTERNAL_SERVER_ERROR);
  } else {
    error = err;
  }
  if (error instanceof ZodError) {
    res.status(400).json(
      createResponse({
        success: false,
        error: {
          code: constants.ErrorCode.BAD_REQUEST,
          message: 'Invalid Request',
          issues: JSON.parse(error.message),
        },
      })
    );
    return;
  }
  if (error.code === constants.ErrorCode.RATE_LIMIT_EXCEEDED) {
    // Playable "Rate Limit Exceeded" stream for stock and kevbox resource URLs
    // (regex shared from utils/stremioResourceUrl.ts, where it is unit-tested).
    const resource = STREMIO_RESOURCE_REQUEST_REGEX.exec(req.originalUrl);
    if (resource) {
      res.json(
        StremioTransformer.createDynamicError(
          resource[1] as
            | 'stream'
            | 'meta'
            | 'addon_catalog'
            | 'subtitles'
            | 'catalog',
          {
            errorDescription: 'Rate Limit Exceeded',
          }
        )
      );
      return;
    }
  }

  res.status(error.statusCode).json(
    createResponse({
      success: false,
      error: {
        code: error.code,
        message: error.message,
      },
    })
  );
  return;
};
