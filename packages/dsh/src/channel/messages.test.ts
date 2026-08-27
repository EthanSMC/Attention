import { describe, it, expect } from 'vitest';
import { extractUrls, isCollectionRequest, formatCollectionReply } from './messages.js';

describe('extractUrls', () => {
  it('extracts http urls', () => {
    const urls = extractUrls('Check https://example.com/article');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('https://example.com/article');
  });

  it('extracts multiple urls', () => {
    const urls = extractUrls('a: https://a.com b: https://b.com');
    expect(urls).toHaveLength(2);
  });

  it('deduplicates urls', () => {
    const urls = extractUrls('https://a.com and https://a.com');
    expect(urls).toHaveLength(1);
  });

  it('returns empty for no urls', () => {
    const urls = extractUrls('hello world');
    expect(urls).toHaveLength(0);
  });

  it('extracts Chinese platform urls', () => {
    const urls = extractUrls('看看这个 https://v.douyin.com/abc/ 和 https://xhslink.com/def');
    expect(urls).toHaveLength(2);
  });
});

describe('isCollectionRequest', () => {
  it('returns true for text with url', () => {
    expect(isCollectionRequest('save https://example.com')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(isCollectionRequest('hello')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isCollectionRequest('')).toBe(false);
  });
});

describe('formatCollectionReply', () => {
  it('formats accepted with title', () => {
    const reply = formatCollectionReply('accepted', 'My Article');
    expect(reply).toContain('My Article');
  });

  it('formats accepted without title', () => {
    const reply = formatCollectionReply('accepted');
    expect(reply).toContain('已收藏');
  });

  it('formats already_collected', () => {
    expect(formatCollectionReply('already_collected')).toContain('已经');
  });

  it('formats ambiguous', () => {
    expect(formatCollectionReply('ambiguous')).toContain('候选');
  });

  it('formats invalid', () => {
    expect(formatCollectionReply('invalid')).toContain('识别');
  });

  it('formats unsafe', () => {
    expect(formatCollectionReply('unsafe')).toContain('安全检查');
  });

  it('formats failed', () => {
    expect(formatCollectionReply('failed')).toContain('失败');
  });

  it('formats unknown status as default', () => {
    const reply = formatCollectionReply('some_new_status');
    expect(reply).toContain('已完成');
  });
});
