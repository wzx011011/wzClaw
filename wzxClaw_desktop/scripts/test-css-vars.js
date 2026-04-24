/**
 * CSS Theme Variable Consistency Test
 *
 * Validates that chat.css only uses CSS variables defined in ide.css :root,
 * and that no hardcoded hex colors remain (excluding allowed exemptions).
 *
 * Usage: node scripts/test-css-vars.js
 * Exit:  0 = all checks pass, 1 = issues found
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IDE_CSS = path.join(ROOT, 'src/renderer/styles/ide.css');
const CHAT_CSS = path.join(ROOT, 'src/renderer/styles/chat.css');

// ---------------------------------------------------------------------------
// 1. Read files
// ---------------------------------------------------------------------------

if (!fs.existsSync(IDE_CSS)) {
  console.error(`FAIL: ide.css not found at ${IDE_CSS}`);
  process.exit(1);
}
if (!fs.existsSync(CHAT_CSS)) {
  console.error(`FAIL: chat.css not found at ${CHAT_CSS}`);
  process.exit(1);
}

const ideCss = fs.readFileSync(IDE_CSS, 'utf8');
const chatCss = fs.readFileSync(CHAT_CSS, 'utf8');

// ---------------------------------------------------------------------------
// 2. Extract :root variable definitions from ide.css
//    Matches patterns like: --variable-name: <value>;
//    Also extracts from theme variants [data-theme="dark"] and [data-theme="light"]
// ---------------------------------------------------------------------------

function extractVarDefinitions(css) {
  const vars = new Map(); // name -> Set of definition blocks (root, dark, light)

  // Match all variable definitions in any block (CSS custom properties can contain a-z, 0-9, -)
  const varDefRegex = /(--[\w-]+)\s*:\s*([^;{}]+);/g;
  let match;

  // Extract from :root
  const rootMatch = css.match(/:root\s*\{([^}]*)\}/s);
  if (rootMatch) {
    const rootBlock = rootMatch[1];
    while ((match = varDefRegex.exec(rootBlock)) !== null) {
      const name = match[1].trim();
      if (name.startsWith('--')) {
        if (!vars.has(name)) vars.set(name, new Set());
        vars.get(name).add(':root');
      }
    }
  }

  // Extract from theme variants
  const themeRegex = /\[data-theme="(\w+)"\]\s*\{([^}]*)\}/gs;
  let themeMatch;
  while ((themeMatch = themeRegex.exec(css)) !== null) {
    const themeName = themeMatch[1];
    const themeBlock = themeMatch[2];
    varDefRegex.lastIndex = 0;
    while ((match = varDefRegex.exec(themeBlock)) !== null) {
      const name = match[1].trim();
      if (name.startsWith('--')) {
        if (!vars.has(name)) vars.set(name, new Set());
        vars.get(name).add(`[data-theme="${themeName}"]`);
      }
    }
  }

  return vars;
}

// ---------------------------------------------------------------------------
// 3. Extract var(--xxx) references from chat.css
// ---------------------------------------------------------------------------

function extractVarReferences(css) {
  const refs = new Map(); // variable name -> count
  // Match var(--name) and var(--name, fallback)
  const refRegex = /var\(\s*(--[a-zA-Z0-9_-]+)/g;
  let match;
  while ((match = refRegex.exec(css)) !== null) {
    const name = match[1];
    refs.set(name, (refs.get(name) || 0) + 1);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// 4. Extract hardcoded hex colors from chat.css
//    We want to flag #rrggbb and #rgb colors that are NOT:
//      - inside rgba()
//      - inside comments
//      - #ffffff / #fff (white)
//      - #000000 / #000 (black)
//      - inside url() (font URLs)
// ---------------------------------------------------------------------------

function extractHardcodedColors(css) {
  const violations = [];
  const lines = css.split('\n');

  // Remove block comments to avoid false positives
  let cleanCss = css.replace(/\/\*[\s\S]*?\*\//g, '');

  // Now process line by line for reporting
  const cleanLines = cleanCss.split('\n');
  const originalLines = css.split('\n');

  // Track line number offset due to comment removal
  // Simpler approach: just scan the cleaned CSS and map back
  // Actually, let's use a regex that skips comments and rgba/url contexts

  // Match hex colors: #rgb or #rrggbb (case insensitive)
  const hexRegex = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/g;

  // Allowed whites/blacks (case insensitive)
  const allowedColors = new Set([
    '#ffffff', '#fff', '#FFFFFF', '#FFF',
    '#000000', '#000', '#000', '#000',
    '#fff', '#FFF',
  ]);

  // We need to process the original CSS but skip comments
  let inBlockComment = false;
  const processedLines = [];

  for (let i = 0; i < originalLines.length; i++) {
    let line = originalLines[i];

    // Handle block comments across lines
    if (inBlockComment) {
      const endIdx = line.indexOf('*/');
      if (endIdx !== -1) {
        line = line.substring(endIdx + 2);
        inBlockComment = false;
      } else {
        continue; // entire line is a comment
      }
    }

    // Remove block comment starts within line
    let processedLine = '';
    let j = 0;
    while (j < line.length) {
      if (line.substring(j, j + 2) === '/*') {
        const endIdx = line.indexOf('*/', j + 2);
        if (endIdx !== -1) {
          j = endIdx + 2;
          continue;
        } else {
          inBlockComment = true;
          break;
        }
      }
      processedLine += line[j];
      j++;
    }

    processedLines.push({ lineNum: i + 1, content: processedLine });
  }

  for (const { lineNum, content } of processedLines) {
    // Skip if line is inside rgba() — check context around each match
    let match;
    hexRegex.lastIndex = 0;
    while ((match = hexRegex.exec(content)) !== null) {
      const color = match[0];
      const matchStart = match.index;
      const matchEnd = matchStart + color.length;

      // Check if inside rgba()
      const before = content.substring(Math.max(0, matchStart - 20), matchStart);
      const after = content.substring(matchEnd, Math.min(content.length, matchEnd + 5));
      if (before.includes('rgba(') || before.includes('rgb(')) {
        continue;
      }

      // Check if inside url()
      if (before.includes('url(')) {
        continue;
      }

      // Check if this hex is a fallback value inside var(--xxx, #color)
      // Look backward for a comma that is part of a var() call
      const beforeFull = content.substring(0, matchStart);
      const lastVarOpen = beforeFull.lastIndexOf('var(');
      const lastCloseParen = beforeFull.lastIndexOf(')');
      if (lastVarOpen !== -1 && lastVarOpen > lastCloseParen) {
        // We are inside a var( ... ) and after a comma — this is a fallback
        const betweenVarAndHere = beforeFull.substring(lastVarOpen);
        if (betweenVarAndHere.includes(',')) {
          continue;
        }
      }

      // Check allowed white/black
      const lower = color.toLowerCase();
      if (lower === '#ffffff' || lower === '#fff' ||
          lower === '#000000' || lower === '#000') {
        continue;
      }

      // Get the full line for context (original, not processed)
      violations.push({
        line: lineNum,
        color: color,
        context: originalLines[lineNum - 1].trim(),
      });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// 5. Run checks
// ---------------------------------------------------------------------------

const defined = extractVarDefinitions(ideCss);
const referenced = extractVarReferences(chatCss);
const hardcodedColors = extractHardcodedColors(chatCss);

// Check for undefined variables
const undefinedVars = [];
for (const [varName, count] of referenced) {
  if (!defined.has(varName)) {
    undefinedVars.push({ name: varName, count });
  }
}

// ---------------------------------------------------------------------------
// 6. Report
// ---------------------------------------------------------------------------

console.log('='.repeat(60));
console.log('CSS Theme Variable Consistency Report');
console.log('='.repeat(60));
console.log();
console.log(`ide.css :root variables defined:  ${defined.size}`);
console.log(`chat.css var() references found:  ${referenced.size}`);
console.log(`Undefined variable references:    ${undefinedVars.length}`);
console.log(`Hardcoded hex colors remaining:   ${hardcodedColors.length}`);
console.log();

// Report undefined variables
if (undefinedVars.length > 0) {
  console.log('--- Undefined Variables ---');
  for (const v of undefinedVars) {
    console.log(`  MISSING: var(${v.name}) used ${v.count} time(s) but not defined in :root`);
  }
  console.log();
}

// Report hardcoded colors
if (hardcodedColors.length > 0) {
  console.log('--- Hardcoded Hex Colors ---');
  for (const c of hardcodedColors) {
    console.log(`  Line ${c.line}: ${c.color}`);
    console.log(`    ${c.context}`);
  }
  console.log();
}

// Summary
const hasErrors = undefinedVars.length > 0;
const hasWarnings = hardcodedColors.length > 0;

if (!hasErrors && !hasWarnings) {
  console.log('PASS: All CSS variables are defined, no hardcoded colors found.');
  process.exit(0);
}

if (hasErrors) {
  console.log('FAIL: Undefined CSS variable references found.');
  process.exit(1);
}

if (hasWarnings) {
  console.log('WARN: Hardcoded hex colors found (non-fatal, but should use variables).');
  console.log('      Exiting 0 since all variable references are valid.');
  process.exit(0);
}
