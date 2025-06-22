import { useState, FormEvent, useEffect } from "react";
import { IconNote, IconExclamationCircle, IconInfoCircle, IconSend2, IconBubble, IconKeyboard, IconPointer, IconCamera, IconCircleCheck } from "@tabler/icons-react";
import CodeBlock from "./components/CodeBlock";


const iconMap = {
  task: IconNote,
  thinking: IconBubble,
  info: IconInfoCircle,
  error: IconExclamationCircle,
  typing: IconKeyboard,
  click: IconPointer,
  screenshot: IconCamera,
  complete: IconCircleCheck
}

const specialColors = {
  error: {
    ringColor: 'ring-re/50',
    bgColor: 'bg-re/15',
    color: 'text-re/90'
  },
  info: {
    ringColor: 'ring-bl/50',
    bgColor: 'bg-bl/15',
    color: 'text-bl'
  },
  complete: {
    ringColor: 'ring-gr/50',
    bgColor: 'bg-gr/15',
    color: 'text-gr/90'
  }
}

type iconType = keyof typeof iconMap;
type specialColorType = keyof typeof specialColors

type message = {
  type: string,
  message: string
}

const App = () => {
  const [prompt, setPrompt] = useState("");
  const [sentPrompts, setSentPrompts] = useState<string[]>([]);
  const [firstPromptSent, setFirstPromptSent] = useState<boolean>(false)
  const [messages, setMessages] = useState<message[]>([{
    type: 'error',
    message: 'tralalala'
  }]);

  useEffect(() => {
    window.ipcRenderer.on("reply", (_, data: message) => {
      setMessages((prev) => [...prev, data]);
    });
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();

    if (!firstPromptSent) setFirstPromptSent(true)
    window.ipcRenderer.sendMessage(prompt);
    setSentPrompts([...sentPrompts, prompt]);
    setPrompt("");
  };

  return (<div className="bg-bg h-screen">
    {prompt && (
      <div>
        <div className="fixed bg-bg px-6 pt-6">
          <p className="text-white/65 mb-4">{prompt}</p>
          <div className="border-b-1 border-white/25"></div>
        </div>
        <div className="p-10"></div>
      </div>
    )}
    
    <div className="flex flex-col bg-bg text-tx p-8 pt-4 bg-2">
      <div className="flex-grow">

        {messages.map(({ type, message }, i) => {
          if (!(type in iconMap)) type = 'info'
          const Icon = iconMap[type as iconType]
          const bg = type in specialColors ? specialColors[type as specialColorType].bgColor : 'bg-bg-2'
          const ring = type in specialColors ? specialColors[type as specialColorType].ringColor : ''
          const color = type in specialColors ? specialColors[type as specialColorType].color : ''

          const titleCaseType = type[0].toUpperCase() + type.slice(1)
         
          return (
            <div 
              key={i} 
              className={"px-6 py-4 rounded-md flex flex-col gap-2 my-4 ring-2 " + bg + " " + ring + " " + color}
            >
              {message.length > 100 ? 
                <>
                  <div className="flex gap-2">
                    <Icon stroke={1.5} />
                    <strong>{titleCaseType}</strong>
                  </div>
                  <p>{message}</p>
                </>
              : <div className="flex gap-2">
                <Icon stroke={1.5} />
                <p><strong>{titleCaseType}</strong> - {message}</p>
              </div>
              }
            </div>
          )
        })}
        {messages.length == 0 && <br />}
      </div>

      <CodeBlock code={`
tell application "Finder"
    activate
    display dialog "Hello from AppleScript!"
end tell
`} />

      {!sentPrompts && <h1 className="font-[Comorant_Garamond] font-serif text-2xl mb-4 text-tx">
        What do you want to run today?
      </h1>}

      <form className="w-full fixed bottom-0 left-0 p-4" onSubmit={handleSubmit}>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={sentPrompts ? "Provide more info..." :"Enter your prompt..."}
          className="flex-grow p-2 w-full h-full rounded-md bg-bg-2 focus:outline-none focus:ring focus:ring-ui-2 placeholder:text-tx-3 resize-none"
        />
        <button
          type="submit"
          className="absolute bottom-2 right-2 bg-tx text-bg hover:bg-white transition hover:cursor-pointer font-bold p-1 rounded-md disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-ui-2 disabled:text-white"
          disabled={prompt.length === 0}
        >
          <IconSend2 size={20} />
        </button>
      </form>

    </div>
  </div>);
};

export default App;
