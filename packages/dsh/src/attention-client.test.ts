import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AttentionClient, isAttentionToolName } from './attention-client.js';

function createMockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
    text: async () => JSON.stringify(response),
  });
}

describe('isAttentionToolName', () => {
  it('recognizes valid tool names', () => {
    expect(isAttentionToolName('attention_get_my_account')).toBe(true);
    expect(isAttentionToolName('attention_collect_content')).toBe(true);
    expect(isAttentionToolName('attention_list_collections')).toBe(true);
  });

  it('rejects invalid tool names', () => {
    expect(isAttentionToolName('invalid_tool')).toBe(false);
    expect(isAttentionToolName('')).toBe(false);
    expect(isAttentionToolName('random_string')).toBe(false);
  });
});

describe('AttentionClient', () => {
  let client: AttentionClient;
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch({});
    client = new AttentionClient({
      config: { apiKey: 'test-key', baseUrl: 'http://test.example' },
      fetchImpl: mockFetch as unknown as typeof fetch,
    });
  });

  it('constructs endpoint correctly', () => {
    expect(client.endpoint).toBe('http://test.example/mcp');
  });

  it('listTools sends tools/list request', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          tools: [{ name: 'attention_get_my_account', description: 'test' }],
        },
      }),
      text: async () => '',
    });
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('attention_get_my_account');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://test.example/mcp',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('callTool sends tools/call with arguments', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          structuredContent: { capabilities: { is_filter: false, is_member: true } },
        },
      }),
      text: async () => '',
    });
    const result = await client.callTool('attention_get_my_account', {});
    expect(result.ok).toBe(true);
    expect(result.value?.capabilities).toBeDefined();
  });

  it('handles structured error responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          error: {
            code: 'insufficient_scope',
            guidance: 'Need profile:read scope.',
            request_id: 'req-123',
          },
        },
      }),
      text: async () => '',
    });
    const result = await client.callTool('attention_get_my_account', {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('insufficient_scope');
  });

  it('handles MCP-level errors', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          isError: true,
          content: [{ type: 'text', text: 'Something went wrong' }],
        },
      }),
      text: async () => '',
    });
    const result = await client.callTool('attention_get_my_account', {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('mcp_error');
  });

  it('includes Bearer token in requests', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ result: { tools: [{ name: 'attention_get_my_account', description: 'test' }] } }),
      text: async () => '',
    });
    await client.listTools();
    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = callArgs[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer test-key');
  });
});
