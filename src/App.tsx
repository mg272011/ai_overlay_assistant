import { useState, useEffect } from "react";

const App = () => {
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    window.ipcRenderer.sendMessage("Hello from Renderer");

    window.ipcRenderer.onReply((data) => {
      console.log("Main replied:", data);
    });
  }, []);

  return (
    <div className="flex flex-col h-screen bg-gray-800 text-white p-4">
      <div className="flex-grow"></div>
      <div className="flex items-center space-x-2">
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Enter your prompt..."
          className="flex-grow p-2 rounded-md bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={() => {
            window.ipcRenderer.sendMessage(prompt);
          }}
          className="bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded-md"
        >
          Send
        </button>
      </div>
    </div>
  );
};

export default App;
