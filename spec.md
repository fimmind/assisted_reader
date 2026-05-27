I want you to create a UI skeleton for a static reader site with assistance functionality. The result must be reader-first, assistance-second. Minimal modern UI, typical for standard high-quality reader. The UI must be adaptive, functioning well on mobile, tablet and desktop screens

The site will be implemented as static HTML/CSS/JS. Create mock up for complex logic. Focus on clean and beautiful UI. Use Alice's Adventures in Wonderland as a mock book

No backend, authentication, file parsing, or real vocabulary estimation is required.
The goal is a polished UI skeleton, not a production app.

Deliver a complete working static UI skeleton with clean, maintainable code with core screens, JavaScript logic and CSS styles all in different files

## Product identity

Name: Easeword
Goal a minimal, calm, reader-first web app for assisted English reading.

The interface should feel closer to Kindle / Readwise Reader / Apple Books / Notion minimalism than to Duolingo. Avoid gamification-heavy visuals, bright reward screens, badges, mascots, and cluttered dashboards.

The user’s default activity is reading. Vocabulary assistance should appear only when it is useful, contextual, and easy to dismiss.

## UI and basic functionality Description 

The core structure is simple. There are two key screens: library and reader. There is a secondary settings screen. Vocabulary quizzes are displayed as pop-ups

### Library

The library screen has a top bar that contains:
* App name (Easeword)
* Light/dark theme switch
* A button for importing new books
* Quiz button for taking additional quizzes
* Settings button for opening the settings screen

Below, in the main body, there is a simple library screen. Every book is represented as its own card. For every book, it displays current progress and the estimated number and percentage of unknown tokens.

### Reader

When the user clicks on a book in the Library screen, the contents of the book open in the reader screen

The UI is minimal. There is a hidable top-bar with dedicated buttons for reader settings, bookmarking, assistance toggle, etc. The reader settings are the typical setting for a reader: font size, spacing, pagination, etc.

The text is displayed centered in the page. For every paragraph, the system identifies the list of words that are unknown by the user, picks up to 2 words which are estimated to be the most important (the exact upper bound for the number of displayed words is adjustable in the settings), highlights them and displays their definition next to the paragraph. The rest of the unknown words are only highlighted and their definition is only displayed when the user clicks on them. On larger screens the definitions are displayed on the right, in a separate dedicated column. The definition cards should align vertically with the corresponding paragraph where possible. On smaller mobile screens the definition cards are displayed right below the corresponding paragraph

The definition card for a given word includes the word itself in its base form, the transcription and the definition. No example sentences. In the top-right corner of the card there are two small buttons for marking the word as known/unknown. 

### Quiz

When the user clicks the Quiz button on the Library's top-bar, a pop-up opens with questions about the number of words in the quiz (default 60) and the number of words in a single adaptive batch (default 20). Then there is a "take quiz" button

Once the user clicks the button, the quiz opens, displaying the list of words with checkboxes, with batches of the given size. For every batch there is a "submit" button which submits this batch. For the final batch there is the "finish" button that submits the final batch and closes the quiz. On the top of the quiz pop-up there is progress information: the total number of batches and the number of the current batch

### Settings

In the settings, there a "profiles" section that allows to change/create/reset/export/import profiles. When deleting a profile the user must be asked for confirmation
