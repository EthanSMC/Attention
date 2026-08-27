import { describe, it, expect } from 'vitest';
import { loadAttentionConfig, mcpEndpoint } from './config.js';

describe('loadAttentionConfig', () => {
  it('returns defaults when no overrides or env vars', () => {
    const cfg = loadAttentionConfig();
    expect(cfg.baseUrl).toBe('http://127.0.0.1:3000');
    expect(cfg.mcpPath).toBe('/mcp');
    expect(cfg.timeoutMs).toBe(30_000);
    expect(cfg.maxRetries).toBe(2);
    expect(cfg.apiKey).toBe('');
  });

  it('accepts overrides', () => {
    const cfg = loadAttentionConfig({
      baseUrl: 'https://attention.example',
      apiKey: 'test-key-123',
      mcpPath: '/custom',
      timeoutMs: 10_000,
      maxRetries: 5,
    });
    expect(cfg.baseUrl).toBe('https://attention.example');
    expect(cfg.apiKey).toBe('test-key-123');
    expect(cfg.mcpPath).toBe('/custom');
    expect(cfg.timeoutMs).toBe(10_000);
    expect(cfg.maxRetries).toBe(5);
  });

  it('partial overrides keep defaults', () => {
    const cfg = loadAttentionConfig({ baseUrl: 'https://custom.example' });
    expect(cfg.baseUrl).toBe('https://custom.example');
    expect(cfg.mcpPath).toBe('/mcp');
    expect(cfg.timeoutMs).toBe(30_000);
  });
});

describe('mcpEndpoint', () => {
  it('constructs endpoint from config', () => {
    const cfg = loadAttentionConfig({ baseUrl: 'http://127.0.0.1:3000' });
    expect(mcpEndpoint(cfg)).toBe('http://127.0.0.1:3000/mcp');
  });

  it('strips trailing slash from baseUrl', () => {
    const cfg = loadAttentionConfig({ baseUrl: 'http://127.0.0.1:3000/' });
    expect(mcpEndpoint(cfg)).toBe('http://127.0.0.1:3000/mcp');
  });

  it('handles custom mcpPath', () => {
    const cfg = loadAttentionConfig({
      baseUrl: 'https://attention.example',
      mcpPath: '/api/mcp',
    });
    expect(mcpEndpoint(cfg)).toBe('https://attention.example/api/mcp');
  });
});
