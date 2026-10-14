# Quiz Batch Helper

This Manifest V3 extension scans a supported multiple-choice quiz, returns to its first question, sends the complete question batch in one prompt to the ChatGPT website, validates the JSON answer list, and applies the answers.

## Use

1. Sign in to ChatGPT in your browser.
2. Open `chrome://extensions`, enable Developer mode, and load or reload this folder as an unpacked extension.
3. Refresh the quiz page, open the quiz, and select **Scan & solve batch** from the extension popup.
4. Keep the browser open while the extension opens ChatGPT in the foreground and sends the scanned batch. After answers arrive, it returns to the quiz and applies them. If the quiz platform requires fullscreen again after switching tabs, click **Enter Full Screen**; the helper waits for the quiz to become available.

The helper supports detected multiple-choice questions only. It will not submit if scanning is incomplete, ChatGPT's JSON response omits or mislabels an answer, option selection cannot be verified, or submission cannot be confirmed. Review the quiz page after completion.
