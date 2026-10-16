# VDO Bridge Local — Narrative Only

Local Mac Mini app: matching Premiere transcript `.json` and source `.xml` pairs → story brief → OpenAI picks → FCP7 XML for Adobe Premiere.

## Setup on Mac

1. Install Node.js 20+ if needed (https://nodejs.org/).
2. In Terminal, change into this folder and run `npm install`.
3. Configure your API key in Terminal **without putting the key into the browser or the project files**:

   ```bash
   export OPENAI_API_KEY='paste-your-openai-api-key-here'
   export OPENAI_MODEL='gpt-4.1'
   npm start
   ```

4. Open http://localhost:3030 in a browser.
5. Enter a project name, drag in matching `.json` and `.xml` interview pairs, enter a story brief, click Generate Premiere XML.
6. Import the downloaded XML in Adobe Premiere; relink media to the Mac-local masters if the source XML contains GX10/R2 paths.

Transcripts and generated XML are stored under `projects/PROJECT_NAME/` on your Mac. The app listens only on `127.0.0.1`, not your network. Transcript text is sent to OpenAI for narrative selection; source XML stays local. API calls use `store:false`. The API key stays on the Node backend.

The original Bridge `buildMultiSourceXml` logic has been carried over. It relies on Premiere-exported FCP7 source XML (sequence, matching audio/video tracks) and timed word-level segments in the JSON. Source files can have different titles but JSON and XML must share a filename stem. Video masters are not uploaded.

**Known limitations:** This release has not been tested on a real interview pair or imported into Premiere. Multi-camera/source XML with unusual track layouts, overlapping IDs from different XML sources, or picks crossing source clip boundaries may need additional fixes. Long transcripts may exceed your model's input limits. The saved XML can still reference original media locations and require relinking.
