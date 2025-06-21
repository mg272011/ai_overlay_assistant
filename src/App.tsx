import { useState, FormEvent, useEffect } from "react";

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
    <div className="flex flex-col h-screen bg-bg text-tx p-4 pt-8">
      <div className="flex-grow">
        {messages.map((msg, i) => (
          <div key={i}>{msg}</div>
        ))}
      </div>
      <form className="flex items-center space-x-2" onSubmit={handleSubmit}>
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Enter your prompt..."
          className="flex-grow p-2 rounded-md bg-bg-2 focus:outline-none focus:ring-2 focus:ring-ui"
        />
        <button
          type="submit"
          className="bg-ui-2 hover:bg-ui-3 text-white font-bold py-2 px-4 rounded-md"
        >
          Send
        </button>
      </form>
    </div>
  );
};

export default App;
