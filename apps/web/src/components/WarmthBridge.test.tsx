import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WarmthBridge } from './WarmthBridge';

describe('WarmthBridge', () => {
  it('uses the full romance scale by default', () => {
    const html = renderToStaticMarkup(<WarmthBridge value={5} ariaLabel="Warmth" />);
    expect(html).toContain('aria-valuemax="100"');
    expect(html).toContain('aria-valuenow="5"');
    expect(html).toContain('width:5%');
  });

  it('fills at the friendship ceiling and uses a handshake endpoint', () => {
    const html = renderToStaticMarkup(<WarmthBridge value={30} maxValue={24} path="friendship" ariaLabel="Friendship warmth" />);
    expect(html).toContain('warmth-bridge-friendship');
    expect(html).toContain('aria-valuemax="24"');
    expect(html).toContain('aria-valuenow="24"');
    expect(html).toContain('width:100%');
    expect(html).toContain('lucide-handshake');
  });
});
