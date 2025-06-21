import { useState, FormEvent, useEffect } from "react";
import { IconNote, IconExclamationCircle, IconInfoCircle, IconSend2, IconBubble, IconKeyboard, IconPointer, IconCamera } from "@tabler/icons-react";
import CodeBlock from "./components/CodeBlock";


const appleScriptCode = `
tell application "Finder"
    activate
    display dialog "Hello from AppleScript!"
end tell
`;


const iconMap = {
  task: IconNote,
  thinking: IconBubble,
  info: IconInfoCircle,
  error: IconExclamationCircle,
  typing: IconKeyboard,
  click: IconPointer,
  screenshot: IconCamera
} 

type iconType = keyof typeof iconMap;

type message = {
  type: string,
  message: string
}

const App = () => {
  const [prompt, setPrompt] = useState("");
  const [sent, setSent] = useState<string[]>([]);
  const [messages, setMessages] = useState<message[]>([]);

  useEffect(() => {
    window.ipcRenderer.on("reply", (_, data: message) => {
      setMessages((prev) => [...prev, data]);
    });
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    window.ipcRenderer.sendMessage(prompt);
    setSent([...sent, prompt]);
    setPrompt("");
  };

  return (
    <div className="flex flex-col bg-bg text-tx p-8 pt-4 bg-2">
      <div className="flex-grow">
        <div className="bg-bl/15 ring-1 ring-bl/50 px-6 py-3 rounded-md flex gap-2 text-bl my-4">
          <IconInfoCircle stroke={1.5} />
          <p><strong>Info</strong> - a system message has appeared!</p>
        </div>
        <div className="bg-re/15 ring-1 ring-re/50 px-6 py-3 rounded-md flex gap-2 text-re/90 my-4">
          <IconExclamationCircle stroke={1.5} />
          <p><strong>Error</strong> - something went wrong...!</p>
        </div>
        <div className="bg-bg-2 px-6 py-4 rounded-md flex flex-col gap-2 my-4">
          <div className="flex gap-2">
            <IconBubble stroke={1.5} />
            <strong>Thinking</strong>
          </div>
          <p className="text-white/65">The user wants me to find a one-way, non-stop flight from San Francisco to Tokyo departing two weeks from now using Google Flights. Let me break this down:</p>
        </div>


        {messages.map(({ type, message }, i) => {
          if (!(type in iconMap)) type = 'info'

          const Icon = iconMap[type as iconType]

          return (
            <div key={i} className="bg-bg-2 px-6 py-4 rounded-md flex flex-col gap-2 my-4">
              <div className="flex gap-2">
                <Icon stroke={1.5} />
                <strong>Task</strong>
              </div>
              <p className="text-white/65">{message}</p>
            </div>
          )
        })}
        {messages.length == 0 && <br />}
      </div>

      <CodeBlock code={appleScriptCode} />

      <h1 className="font-[Comorant_Garamond] font-serif text-2xl mb-4 text-tx">
        What do you want to run today?
      </h1>
      <form className="w-full relative" onSubmit={handleSubmit}>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Enter your prompt..."
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
  );
};

export default App;
