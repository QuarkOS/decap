# decap

decap saves a before image and an after image when a commit changes a line that is at least 12 hours old. You write why you made the change. You can search that note later.

## Quick start

Install `quarkos.decap` from Open VSX in Cursor or VS Code. Open a folder that contains a git repository.

## Commit a change

Commit a change to a line that is at least 12 hours old while the window is open. decap saves the before image and the after image. A commit made while the window is closed is saved the next time you open the folder, when the line is at least 12 hours old.

A notice says that decap saved the change. The notice offers **Fill in why**. The status bar shows `decap: fill in why`.

![A notice in VS Code says decap saved the capture and offers Fill in why.](docs/images/capture-notice.png)

If the line is less than 12 hours old, decap does not save images. The notice offers **Review anyway**.

![A notice in VS Code says the lines are less than a minute old and offers Review anyway.](docs/images/review-anyway.png)

Run **decap: Review last commit** to save the latest commit at any age.

## Capture the selection

Select the lines you want to record. Run **decap: Capture selection**. decap saves the before image and the after image for that range, including edits that are not saved yet, and opens Fill in why.

A selection with no change against the last commit saves nothing.

## Copy a capture

Open a capture, or leave one selected in Decisions. Run **decap: Copy snippet**. The clipboard gets a Markdown block with the file, the reason, and the diff. Paste it into a pull request.

## Fill in why

**Fill in why** opens a form for the changed file. The form shows the before image and the after image. Write the reason, then choose **Save**.

![The Fill in why form shows the before image and the after image for billing.py, with an empty box for the reason.](docs/images/fill-in-why.png)

## Past decisions

Run **decap: Open decisions** to open the list. The newest capture is first. Type in **Search** to keep rows that match the reason, the file name, or the age.

![The Decisions list shows a search for shorter, with one capture, its before image, its after image, and the saved reason.](docs/images/decisions-search.png)

## MCP server

Agents can capture a commit or a line range, list saved captures, and read the why note. The server speaks MCP over stdio and uses the same capture code as the extension. It is not part of the published extension package. Build it from a checkout.

```bash
cd extension
npm ci
npm run compile
```

In Cursor, add this to `mcp.json`. The path is the compiled server in that checkout.

```json
{
  "mcpServers": {
    "decap": {
      "command": "node",
      "args": ["/absolute/path/to/decap/extension/out/mcp.js"]
    }
  }
}
```

The tools are `decap_capture_commit`, `decap_capture_range`, `decap_list_captures`, and `decap_read_why`. `root` is the absolute path of the git repository. A line range counts from 1 and is inclusive. Omit `rev` on `decap_capture_range` to compare the file on disk with HEAD.
