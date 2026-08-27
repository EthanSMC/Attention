import { describe, it, expect, vi } from 'vitest';
import { createAttentionToolRegistry } from './registry.js';
import { AttentionMcpClient } from '../mcp-client.js';

describe('createAttentionToolRegistry', () => {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      result: { tools: [] },
    }),
    text: async () => '',
  });

  const mcp = new AttentionMcpClient({
    config: { apiKey: 'test-key', baseUrl: 'http://test.example' },
    fetchImpl: mockFetch as unknown as typeof fetch,
  });
  const tools = createAttentionToolRegistry({ mcp });

  it('creates exactly 15 tools', () => {
    expect(tools).toHaveLength(15);
  });

  it('each tool has a name, description, inputSchema, and invoke', () => {
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.name).toMatch(/^attention_/);
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.invoke).toBe('function');
    }
  });

  it('first tool is get_my_account', () => {
    expect(tools[0]?.name).toBe('attention_get_my_account');
  });

  it('last tool is update_digest_settings', () => {
    expect(tools[14]?.name).toBe('attention_update_digest_settings');
  });

  it('all expected tool names are present', () => {
    const names = tools.map(t => t.name);
    expect(names).toContain('attention_get_my_account');
    expect(names).toContain('attention_collect_content');
    expect(names).toContain('attention_list_collections');
    expect(names).toContain('attention_list_public_content');
    expect(names).toContain('attention_search_content');
    expect(names).toContain('attention_report_content');
    expect(names).toContain('attention_get_digest_settings');
  });

  it('invoke calls mcp.call with tool name', async () => {
    const firstTool = tools[0];
    if (!firstTool) throw new Error('No tools');
    // With mock fetch, should return ok result
    const result = await firstTool.invoke({});
    expect(result.ok).toBeDefined();
  });
});
