import { accessMiddleware } from '../_lib/access.js';

export const onRequest = [accessMiddleware()];
