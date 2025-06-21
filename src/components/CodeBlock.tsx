import ShikiHighlighter, { 
  createHighlighterCore,        // re-exported from shiki/core
  createOnigurumaEngine,        // re-exported from shiki/engine/oniguruma
  createJavaScriptRegexEngine,  // re-exported from shiki/engine/javascript
} from 'react-shiki/core';

// Create custom highlighter with dynamic imports to optimize client-side bundle size
const highlighter = await createHighlighterCore({
  themes: [import('@shikijs/themes/vitesse-dark')],
  langs: [import('@shikijs/langs/applescript')],
  engine: createOnigurumaEngine(import('shiki/wasm')) 
    // or createJavaScriptRegexEngine()
});

const CodeBlock = ({ code }: { code: string }) => (
    <ShikiHighlighter highlighter={highlighter} language="applescript" showLanguage={false} showLineNumbers={true} theme="vitesse-dark">
      {code.trim()}
    </ShikiHighlighter>
)

export default CodeBlock