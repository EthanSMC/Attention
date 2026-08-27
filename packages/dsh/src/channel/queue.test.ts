import { describe, it, expect } from 'vitest';
import { createMessageQueue } from './queue.js';

describe('createMessageQueue', () => {
  it('starts empty', () => {
    const q = createMessageQueue();
    expect(q.inboundCount).toBe(0);
    expect(q.outboundCount).toBe(0);
  });

  it('enqueues and dequeues inbound', () => {
    const q = createMessageQueue();
    q.enqueueInbound({ messageId: '1', fromUser: 'u1', content: 'hi', timestamp: 1 });
    expect(q.inboundCount).toBe(1);
    const msg = q.dequeueInbound();
    expect(msg?.messageId).toBe('1');
    expect(q.inboundCount).toBe(0);
  });

  it('returns null on empty dequeue', () => {
    const q = createMessageQueue();
    expect(q.dequeueInbound()).toBeNull();
    expect(q.dequeueOutbound()).toBeNull();
  });

  it('enqueues and dequeues outbound', () => {
    const q = createMessageQueue();
    q.enqueueOutbound({ replyTo: 'u1', content: 'reply' });
    expect(q.outboundCount).toBe(1);
    const msg = q.dequeueOutbound();
    expect(msg?.content).toBe('reply');
  });

  it('respects FIFO order', () => {
    const q = createMessageQueue();
    q.enqueueInbound({ messageId: '1', fromUser: 'u1', content: 'a', timestamp: 1 });
    q.enqueueInbound({ messageId: '2', fromUser: 'u1', content: 'b', timestamp: 2 });
    expect(q.dequeueInbound()?.content).toBe('a');
    expect(q.dequeueInbound()?.content).toBe('b');
  });
});
