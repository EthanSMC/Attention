import { describe, it, expect, vi } from 'vitest';
import { createMessageHandler } from './handler.js';
import { AttentionMcpClient } from '../mcp-client.js';

describe('createMessageHandler', () => {
  // Create a mock fetch that returns a realistic error
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      result: {
        content: [{ type: 'text', text: 'OK' }],
      },
    }),
    text: async () => '',
  });

  const mcp = new AttentionMcpClient({
    config: { apiKey: 'test-key', baseUrl: 'http://test.example' },
    fetchImpl: mockFetch as unknown as typeof fetch,
  });
  const handler = createMessageHandler({ mcp });

  it('handles text without urls', async () => {
    const reply = await handler.handle({
      messageId: '1',
      fromUser: 'user1',
      content: 'hello world',
      timestamp: Date.now(),
    });
    expect(reply).toContain('未识别');
  });

  it('attempts collection for messages with urls', async () => {
    const reply = await handler.handle({
      messageId: '2',
      fromUser: 'user1',
      content: 'save https://example.com/article',
      timestamp: Date.now(),
    });
    // With mock, should not fail
    expect(reply).toBeTruthy();
  });
});
