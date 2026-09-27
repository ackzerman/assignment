// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'App.css');
const css = fs.readFileSync(cssPath, 'utf8');

function ruleFor(selector) {
  const match = css.match(new RegExp(`${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : null;
}

describe('Required approval badge styling', () => {
  it('.approval-badge.required is bold', () => {
    const rule = ruleFor('.approval-badge.required');
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/font-weight:\s*700/);
  });

  it('.approval-badge-sm.required is bold', () => {
    const rule = ruleFor('.approval-badge-sm.required');
    expect(rule).toBeTruthy();
    expect(rule).toMatch(/font-weight:\s*700/);
  });
});
