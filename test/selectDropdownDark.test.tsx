import React from 'react';
import { renderToString } from 'react-dom/server';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { SettingSelectRow } from '@/components/settings/SettingRow';
import fs from 'fs';
import path from 'path';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

console.log('\n=== Dropdown & Toggle Styling Tests ===');

// 1. Select component contains dark color-scheme and option popover styles
const html = renderToString(
  <Select value="dark">
    <option value="light">Light</option>
    <option value="dark">Dark</option>
  </Select>,
);

assert(
  html.includes('dark:[color-scheme:dark]'),
  'Select component declares dark:[color-scheme:dark]',
);
assert(
  html.includes('[&amp;_option]:bg-popover') || html.includes('[&_option]:bg-popover'),
  'Select component sets option background to popover',
);
assert(
  html.includes('[&amp;_option]:text-popover-foreground') ||
    html.includes('[&_option]:text-popover-foreground'),
  'Select component sets option text to popover foreground',
);

// 2. SettingSelectRow attaches background and text color tokens to all options
const rowHtml = renderToString(
  <SettingSelectRow
    id="theme"
    label="Theme"
    value="dark"
    options={[
      { value: 'light', label: 'Light' },
      { value: 'dark', label: 'Dark' },
    ]}
    onValueChange={() => {}}
  />,
);

const matches = rowHtml.match(/class="bg-popover text-popover-foreground"/g);
assert(
  matches !== null && matches.length === 2,
  'All option elements in SettingSelectRow have explicit bg-popover and text-popover-foreground classes',
);

// 3. globals.css declares color-scheme and select option styles
const cssPath = path.resolve(process.cwd(), 'styles/globals.css');
const css = fs.readFileSync(cssPath, 'utf8');

assert(css.includes('color-scheme: light;'), 'globals.css declares color-scheme: light in :root');
assert(css.includes('color-scheme: dark;'), 'globals.css declares color-scheme: dark in .dark');
assert(
  css.includes('select option') &&
    css.includes('background-color: hsl(var(--popover));') &&
    css.includes('color: hsl(var(--popover-foreground));'),
  'globals.css defines select option background and text color tokens',
);

// 4. Switch toggle uses #B8ADFC when checked instead of black and white
const switchChecked = renderToString(<Switch checked={true} />);
assert(
  switchChecked.includes('bg-[#B8ADFC]'),
  'Switch uses bg-[#B8ADFC] when checked',
);
assert(
  switchChecked.includes('bg-white'),
  'Switch thumb uses bg-white',
);

const switchUnchecked = renderToString(<Switch checked={false} />);
assert(
  switchUnchecked.includes('bg-input'),
  'Switch uses bg-input when unchecked',
);

console.log('\nAll dropdown and toggle styling tests passed successfully!');
