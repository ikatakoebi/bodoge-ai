/**
 * Browser-based step controller for replay.
 * Starts a tiny HTTP server that the injected browser UI calls.
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';

export class StepController {
  private paused = false;
  private autoPlay = true;
  private quit = false;
  private stepResolve: (() => void) | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private port: number;
  private currentRound = 0;
  private totalRounds = 0;
  private statusMessage = '';

  constructor(port = 3216) {
    this.port = port;
    this.startServer();
  }

  private startServer(): void {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // CORS headers for browser access
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = req.url || '';

      if (url === '/pause') {
        this.paused = true;
        this.autoPlay = false;
        res.end(JSON.stringify({ ok: true, state: 'paused' }));
      } else if (url === '/resume') {
        this.autoPlay = true;
        this.paused = false;
        this.resume();
        res.end(JSON.stringify({ ok: true, state: 'playing' }));
      } else if (url === '/step') {
        this.autoPlay = false;
        this.resume();
        res.end(JSON.stringify({ ok: true, state: 'stepped' }));
      } else if (url === '/quit') {
        this.quit = true;
        this.resume();
        res.end(JSON.stringify({ ok: true, state: 'quit' }));
      } else if (url === '/status') {
        res.end(JSON.stringify({
          paused: this.paused,
          autoPlay: this.autoPlay,
          round: this.currentRound,
          totalRounds: this.totalRounds,
          message: this.statusMessage,
        }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });

    this.server.listen(this.port, () => {
      console.log(`[step] Control server: http://localhost:${this.port}`);
    });
  }

  private resume(): void {
    if (this.stepResolve) {
      const resolve = this.stepResolve;
      this.stepResolve = null;
      resolve();
    }
  }

  setRoundInfo(round: number, total: number): void {
    this.currentRound = round;
    this.totalRounds = total;
  }

  setStatus(msg: string): void {
    this.statusMessage = msg;
  }

  async delayOrStep(ms: number): Promise<boolean> {
    if (this.quit) return false;
    if (this.paused) {
      // Wait for step or resume
      await new Promise<void>((resolve) => {
        this.stepResolve = resolve;
      });
      if (this.quit) return false;
      if (!this.autoPlay) {
        this.paused = true; // Re-pause after single step
      }
      return true;
    }
    // Auto-play: normal delay
    await new Promise(resolve => setTimeout(resolve, ms));
    return !this.quit;
  }

  isQuit(): boolean {
    return this.quit;
  }

  getPort(): number {
    return this.port;
  }

  destroy(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
