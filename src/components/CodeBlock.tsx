import ShikiHighlighter, { 
  createHighlighterCore,
  createOnigurumaEngine, 
} from 'react-shiki/core';

import { addCopyButton } from 'shiki-transformer-copy-button'

const highlighter = await createHighlighterCore({
  themes: [import('@shikijs/themes/vitesse-black')],
  langs: [import('@shikijs/langs/applescript')],
  engine: createOnigurumaEngine(import('shiki/wasm'))
});

const CodeBlock = ({ code }: { code: string }) => (
    
    <ShikiHighlighter
        highlighter={highlighter}
        language="applescript"
        showLanguage={true}
        showLineNumbers={true}
        theme="vitesse-black"
        transformers={[addCopyButton({})]}
        className="text-xs"
    >
      {code.trim()}
    </ShikiHighlighter>
)

export default CodeBlock