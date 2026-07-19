// Unifold Node API client (server-side, secret key). Source of the USDC grant.
import Unifold from '@unifold/node';
import { UNIFOLD_SECRET_KEY } from './config.js';

export const unifold = new Unifold(UNIFOLD_SECRET_KEY);
