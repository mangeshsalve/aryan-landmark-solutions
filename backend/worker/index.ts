import { Container, getRandom } from '@cloudflare/containers';

export class AryanLandmarkBackend extends Container {
  defaultPort = 3000;

  sleepAfter = '1h';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = await getRandom(env.BACKEND, 3);

    return container.fetch(request);
  },
};