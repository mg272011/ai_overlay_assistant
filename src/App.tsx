import { useState, FormEvent, useEffect } from "react";
import { IconSend2 } from "@tabler/icons-react";

const App = () => {
  const [prompt, setPrompt] = useState("");
  const [sent, setSent] = useState<string[]>([]);
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    window.ipcRenderer.onReply((data) => {
      setMessages((prev) => [...prev, data]);
    });
  }, []);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    window.ipcRenderer.sendMessage(prompt);
    setSent(...sent, prompt);
    setPrompt("");
  };

  return (
    <div className="flex flex-col h-screen bg-bg text-tx p-8 pt-12 bg-2">
      <div className="flex-grow">
        {messages.map((msg, i) => (
          <div key={i}>{msg}</div>
        ))}
      </div>
      <h1 className="font-[Comorant_Garamond] font-serif text-2xl mb-4 text-tx">What do you want to run today?</h1>
      <form className="w-full relative" onSubmit={handleSubmit}>
        <textarea
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
