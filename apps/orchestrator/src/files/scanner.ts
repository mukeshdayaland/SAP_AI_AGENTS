import { connect } from 'node:net';

export interface ScanResult {
  clean: boolean;
  signature?: string;
}

/** Malware-scanning integration point. */
export interface MalwareScanner {
  readonly name: string;
  scan(data: Buffer): Promise<ScanResult>;
}

/** Development only — configuration refuses it in PROD when uploads are enabled. */
export class NoopScanner implements MalwareScanner {
  readonly name = 'none';
  async scan(): Promise<ScanResult> {
    return { clean: true };
  }
}

/**
 * ClamAV `clamd` INSTREAM protocol. Fails closed: any error or timeout
 * rejects the upload.
 */
export class ClamAvScanner implements MalwareScanner {
  readonly name = 'clamav';

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 20_000,
  ) {}

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      const chunks: Buffer[] = [];
      socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error('ClamAV timeout')));
      socket.on('error', reject);
      socket.on('data', (c) => chunks.push(c));
      socket.on('end', () => {
        const reply = Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim();
        if (/: OK$/.test(reply)) resolve({ clean: true });
        else if (/FOUND$/.test(reply)) resolve({ clean: false, signature: reply.replace(/^stream: /, '').replace(/ FOUND$/, '') });
        else reject(new Error(`Unexpected ClamAV reply: ${reply.slice(0, 100)}`));
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let i = 0; i < data.length; i += 64 * 1024) {
          const chunk = data.subarray(i, i + 64 * 1024);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          socket.write(len);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4));
      });
    });
  }
}
