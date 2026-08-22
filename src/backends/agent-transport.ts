import { decodeAgentFrame, encodeAgentFrame, type AgentRequest, type AgentResponse } from '../agent-protocol.ts';
import { ServiceError } from '../domain/errors.ts';
import type { AgentTransport } from './types.ts';

interface PendingResponse {
  resolve(response: AgentResponse): void;
  reject(error: Error): void;
}

interface WritableSocket {
  write(data: Uint8Array): number;
}

export class SocketFrameWriter {
  private socket: WritableSocket | undefined;
  private readonly frames: Buffer[] = [];
  private offset = 0;

  attach(socket: WritableSocket): void {
    this.socket = socket;
  }

  write(frame: Uint8Array): void {
    if (!this.socket) throw new Error('Agent socket is unavailable');
    this.frames.push(Buffer.from(frame));
    this.flush();
  }

  drain(): void {
    this.flush();
  }

  clear(): void {
    this.frames.length = 0;
    this.offset = 0;
    this.socket = undefined;
  }

  private flush(): void {
    if (!this.socket) return;
    while (this.frames.length > 0) {
      const frame = this.frames[0]!;
      const written = this.socket.write(frame.subarray(this.offset));
      if (written <= 0) return;
      this.offset += written;
      if (this.offset < frame.byteLength) return;
      this.frames.shift();
      this.offset = 0;
    }
  }
}

export class AgentFrameChannel implements AgentTransport {
  private buffer = Buffer.alloc(0);
  private readonly pending: PendingResponse[] = [];
  private closed = false;

  constructor(
    private readonly writeFrame: (frame: Uint8Array) => void,
    private readonly closeChannel: () => void,
  ) {}

  push(chunk: Uint8Array): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > 2 * 1024 * 1024) {
        this.fail(new Error('Guest agent frame exceeds limit'));
        return;
      }
      if (this.buffer.length < length + 4) return;
      const frame = this.buffer.subarray(0, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      const pending = this.pending.shift();
      if (!pending) {
        this.fail(new Error('Guest agent sent an unsolicited response'));
        return;
      }
      try {
        pending.resolve(decodeAgentFrame(frame));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  request(input: AgentRequest): Promise<AgentResponse> {
    if (this.closed) return Promise.reject(new ServiceError('BACKEND_ERROR', 'Guest agent transport is closed'));
    const response = new Promise<AgentResponse>((resolve, reject) => this.pending.push({ resolve, reject }));
    try {
      this.writeFrame(encodeAgentFrame(input));
    } catch (error) {
      const pending = this.pending.pop();
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return response;
  }

  fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.splice(0)) pending.reject(error);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeChannel();
    for (const pending of this.pending.splice(0)) pending.reject(new Error('Guest agent transport closed'));
  }
}
