import { formatAdaptiveValue, formatCompactCount } from '../lib/monitors/formatValue';
import { detectSemanticValue } from '../lib/monitors/semanticValue';

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

function assertEqual(actual: string | null | undefined, expected: string | null | undefined, message: string) {
  if (actual !== expected) {
    console.error(`FAIL: ${message} (expected: "${expected}", got: "${actual}")`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message} -> "${actual}"`);
  }
}

section('1. Currency: Insignificant Trailing Decimals & Meaningful Cents');
{
  // Large currency hides insignificant cents ($77,158 instead of $77,158.15)
  assertEqual(formatAdaptiveValue('$77,158.15'), '$77,158', 'large currency hides cents ($77,158.15 -> $77,158)');
  assertEqual(formatAdaptiveValue('$77,158.00'), '$77,158', 'large currency with .00 ($77,158.00 -> $77,158)');
  assertEqual(formatAdaptiveValue('$77,158'), '$77,158', 'large currency without decimals ($77,158 -> $77,158)');
  assertEqual(formatAdaptiveValue('€1,250.50'), '€1,250', 'large Euro amount hides cents (€1,250.50 -> €1,250)');
  assertEqual(formatAdaptiveValue('£15,000.99'), '£15,000', 'large GBP amount hides cents (£15,000.99 -> £15,000)');
  assertEqual(formatAdaptiveValue('-$77,158.15'), '-$77,158', 'negative large currency hides cents (-$77,158.15 -> -$77,158)');

  // Trailing zeros are always hidden ($10 instead of $10.00)
  assertEqual(formatAdaptiveValue('$10.00'), '$10', 'currency hides .00 ($10.00 -> $10)');
  assertEqual(formatAdaptiveValue('$450.00'), '$450', 'currency hides .00 ($450.00 -> $450)');
  assertEqual(formatAdaptiveValue('$50.0'), '$50', 'currency hides .0 ($50.0 -> $50)');
  assertEqual(formatAdaptiveValue('10.00 USD'), '10 USD', 'ISO code currency hides .00 (10.00 USD -> 10 USD)');
  assertEqual(formatAdaptiveValue('€0.00'), '€0', 'zero currency hides .00 (€0.00 -> €0)');

  // Meaningful cents on smaller amounts are strictly preserved
  assertEqual(formatAdaptiveValue('$4.99'), '$4.99', 'small currency preserves cents ($4.99 -> $4.99)');
  assertEqual(formatAdaptiveValue('$0.50'), '$0.50', 'cents under one dollar preserved ($0.50 -> $0.50)');
  assertEqual(formatAdaptiveValue('$12.75'), '$12.75', 'moderate small currency preserves cents ($12.75 -> $12.75)');
  assertEqual(formatAdaptiveValue('€99.95'), '€99.95', 'sub-thousand Euro price preserves cents (€99.95 -> €99.95)');
}

section('2. Counts and Views: Compact Notation & Small Counts');
{
  // Large counts compact to 1.3M, 90k
  assertEqual(formatAdaptiveValue('1,300,000'), '1.3M', '1.3 million count compacts (1,300,000 -> 1.3M)');
  assertEqual(formatAdaptiveValue('1300000'), '1.3M', 'raw 1.3M without commas compacts (1300000 -> 1.3M)');
  assertEqual(formatAdaptiveValue('90,000'), '90k', '90 thousand count compacts (90,000 -> 90k)');
  assertEqual(formatAdaptiveValue('90000'), '90k', 'raw 90k without commas compacts (90000 -> 90k)');
  assertEqual(formatAdaptiveValue('1,000'), '1k', 'exact thousand compacts (1,000 -> 1k)');
  assertEqual(formatAdaptiveValue('1,500'), '1.5k', 'one and half thousand compacts (1,500 -> 1.5k)');
  assertEqual(formatAdaptiveValue('10,000'), '10k', 'ten thousand compacts (10,000 -> 10k)');
  assertEqual(formatAdaptiveValue('100,000'), '100k', 'hundred thousand compacts (100,000 -> 100k)');
  assertEqual(formatAdaptiveValue('1,000,000'), '1M', 'exact million compacts without .0 (1,000,000 -> 1M)');
  assertEqual(formatAdaptiveValue('2,500,000,000'), '2.5B', 'billions compact (2,500,000,000 -> 2.5B)');

  // Keywords (views, followers)
  assertEqual(formatAdaptiveValue('1,300,000 views'), '1.3M views', 'views keyword compacts (1,300,000 views -> 1.3M views)');
  assertEqual(formatAdaptiveValue('90,000 followers'), '90k followers', 'followers keyword compacts (90,000 followers -> 90k followers)');

  // Small counts preserved as plain numbers
  assertEqual(formatAdaptiveValue('1'), '1', 'single count preserved (1 -> 1)');
  assertEqual(formatAdaptiveValue('42'), '42', 'small count preserved (42 -> 42)');
  assertEqual(formatAdaptiveValue('850'), '850', 'count under thousand preserved (850 -> 850)');

  // Already compact counts remain intact
  assertEqual(formatAdaptiveValue('1.3M'), '1.3M', 'already compact 1.3M preserved');
  assertEqual(formatAdaptiveValue('90k'), '90k', 'already compact 90k preserved');
}

section('3. Percentages: Preserving Exact Precision');
{
  assertEqual(formatAdaptiveValue('54.55%'), '54.55%', 'percentage preserves exact precision (54.55% -> 54.55%)');
  assertEqual(formatAdaptiveValue('0.05%'), '0.05%', 'small percentage preserves precision (0.05% -> 0.05%)');
  assertEqual(formatAdaptiveValue('+12.34%'), '+12.34%', 'signed percentage preserves precision (+12.34% -> +12.34%)');
  assertEqual(formatAdaptiveValue('-3.5%'), '-3.5%', 'negative percentage preserves precision (-3.5% -> -3.5%)');
  assertEqual(formatAdaptiveValue('100%'), '100%', 'whole percentage preserved (100% -> 100%)');
}

section('4. Meaningful Decimals: Preserving Exact Precision');
{
  assertEqual(formatAdaptiveValue('1.25'), '1.25', 'meaningful decimal 1.25 preserved (1.25 -> 1.25)');
  assertEqual(formatAdaptiveValue('0.05'), '0.05', 'small decimal preserved (0.05 -> 0.05)');
  assertEqual(formatAdaptiveValue('3.14159'), '3.14159', 'multi-digit decimal preserved (3.14159 -> 3.14159)');
  assertEqual(formatAdaptiveValue('9.8'), '9.8', 'single decimal place preserved (9.8 -> 9.8)');
  assertEqual(formatAdaptiveValue('42.5'), '42.5', 'mid-range decimal preserved (42.5 -> 42.5)');
}

section('5. Large Values: Adaptive Semantic Rules Under Scale');
{
  // Large currency: cents hidden
  assertEqual(formatAdaptiveValue('$77,158.15'), '$77,158', 'large currency: cents hidden');
  assertEqual(formatAdaptiveValue('$1,500,000.00'), '$1,500,000', 'large currency: millions with zero cents');

  // Large counts: compact notation
  assertEqual(formatAdaptiveValue('1,300,000'), '1.3M', 'large count: compact M');
  assertEqual(formatAdaptiveValue('90,000'), '90k', 'large count: compact k');

  // Large decimals (non-currency, non-integer): precision preserved
  assertEqual(formatAdaptiveValue('1,250.75'), '1,250.75', 'large decimal preserves precision');

  // Large percentage: precision preserved
  assertEqual(formatAdaptiveValue('1,250.55%'), '1,250.55%', 'large percentage preserves precision');
}

section('6. Cached SemanticValue Passthrough & Non-Destructive Invariants');
{
  const rawBitcoin = '$77,158.15';
  const detected = detectSemanticValue(rawBitcoin);
  assertEqual(formatAdaptiveValue(rawBitcoin, detected), '$77,158', 'passes cached semantic value seamlessly');
  assertEqual(rawBitcoin, '$77,158.15', 'original raw stored string is never mutated');

  // Text values preserved untouched
  assertEqual(formatAdaptiveValue('In Stock'), 'In Stock', 'plain text preserved');
  assertEqual(formatAdaptiveValue('Out of Stock'), 'Out of Stock', 'plain text preserved');
  assertEqual(formatAdaptiveValue(''), '', 'empty string returns empty');
  assertEqual(formatAdaptiveValue(null), null, 'null returns null');
}

console.log('\nAll adaptive value formatting tests passed successfully!');
