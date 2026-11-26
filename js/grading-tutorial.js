// The grading tutorial: a guided tour of the Grading tab, for teachers.
//
// It uses the card of the tutorial for players (tutorial.js), with steps of its
// own. It grades a sample batch: a zip file made here, as Canvas' "Download
// submissions" makes it, with two made-up students ("studenta" and "studentb",
// as Canvas names them). The sample is graded in a separate session, kept in
// memory only (GraderTab.enter_sample): the grader's own grading is put away
// while the tutorial runs, and comes back when it is closed.
//
// The page (main.js) passes in what the steps need (`app`):
//   grader          the Grading tab (grader.js)
//   select_tab(n)
//   load_sample()   loads the sample batch (sample_submissions) into the Grading tab
import { make_zip } from './folder.js';
import { PdfDocument } from './pdf.js';

export const GRADING_TUTORIAL_KEY = 'logic-game:grading-tutorial';

const $ = (id) => document.getElementById(id);

// The key of studenta in the sample session (see GraderTab.load_list).
const SAMPLE_A = 'sample:canvas:1';

// A small PDF, as the report a student hands in.
function report_pdf(student, lines) {
  const doc = new PdfDocument({ title: `Report of ${student}` });
  doc.heading(`Report of ${student} (a made-up student)`, 1);
  for (const line of lines) doc.text(line);
  return doc.output();
}

async function example(name) {
  const response = await fetch(`examples/${name}.json`);
  if (!response.ok) throw new Error(`could not load the example ${name} (${response.status})`);
  return response.text();
}

// The sample batch: [{ name, bytes }], one zip file of all submissions, with the
// names Canvas gives the files (<name>_<LATE_><user id>_<submission id>_<file name>).
// studenta handed in a zip file of their own (a game file and a PDF), studentb
// handed in late, with the game file and the PDF as two separate files.
export async function sample_submissions() {
  const a = await example('flag9-with-solutions');
  const b = await example('flag5-with-solutions');
  const zip = make_zip({
    'studenta_1_101_homework.zip': make_zip({
      'homework/game.json': a,
      'homework/report.pdf': report_pdf('studenta', [
        'My game: find the flag, while an attacker chases the player.',
        'The attacker is a moving NPC. Levels are random (RANDINT). The strategy wins on new levels.',
      ]),
    }),
    'studentb_LATE_2_201_game.json': b,
    'studentb_LATE_2_202_report.pdf': report_pdf('studentb', [
      'My game: the player only sees the cells around it, and has to find the flag.',
    ]),
  });
  return [{ name: 'submissions.zip', bytes: zip }];
}

// The steps (see make_steps in tutorial.js for what the fields mean).
export function grading_tutorial_steps(app) {
  const g = app.grader;
  const student = () => g.student(SAMPLE_A);
  const decided = () => Object.values((student() || {}).scores || {}).some((x) => x && x.value);
  return [
    {
      title: 'Grading, step by step',
      text: `<p>This tutorial shows how to grade with the <b>Grading</b> tab, from the zip file of Canvas
        to the feedback for the students. It takes about five minutes.</p>
        <p>It uses a <b>sample</b> of two made-up students. Your own grading is put aside while the
        tutorial runs (it stays in this browser), and comes back when you close the tutorial.</p>`,
      next: 'Start',
    },
    {
      title: 'Load the submissions',
      target: () => $('grading-form'),
      enter: () => app.select_tab(8),
      text: `<p>In Canvas, <i>Download submissions</i> (on the page of the assignment) gives one zip file
        with the files of all students. <b>Load submissions</b> reads that zip file as it is: the files
        are grouped per student, and the game file and the PDF of each student are found.</p>
        <p>For this tutorial there is a sample zip file, with two made-up students, named as Canvas
        names them: <i>studenta</i> and <i>studentb</i>. Click <b>Do it for me</b> to load it.</p>`,
      done: () => g.students.length >= 2,
      do_it: () => app.load_sample(),
      after: () => `<p>Two students are in the list. <i>late</i> means that the submission was handed in
        after the deadline.</p>`,
    },
    {
      title: 'Grade a student',
      target: () => document.querySelector(`#grading-students button[data-key="${SAMPLE_A}"]`) || $('grading-students'),
      enter: () => app.select_tab(8),
      text: `<p>Click <b>Grade</b> next to <i>studenta</i>.</p>
        <p>Their game is loaded into the page: you can read its programs in the editors, and play it on
        the board. Their PDF is shown next to the rubric.</p>`,
      done: () => g.current === SAMPLE_A,
      do_it: () => g.open_student(SAMPLE_A),
      after: () => `<p>What you change in the game of a student is kept apart from what they handed
        in: <i>Back to what was handed in</i> undoes it.</p>`,
    },
    {
      title: 'Test and measure',
      target: () => $('grading-measure'),
      enter: () => {
        app.select_tab(8);
        $('grading-levels').value = '3';      // (quick, for the tutorial)
      },
      text: `<p><b>Test and measure</b> plays the game on new levels, and measures how long the programs
        take, what the player does not see, which objects move, and whether the memory is used. It also
        compares the game with the example games and the other submissions.</p>
        <p>Click it (here with 3 levels, to be quick; by default 20).</p>`,
      done: () => Boolean(student() && student().measurements) && !g.measuring,
      do_it: () => g.measure(),
      after: () => `<p>The results are below the button. A level that was not won can be loaded onto
        the board, to watch what happens.</p>`,
    },
    {
      title: 'Suggestions, and your decision',
      target: () => $('grading-rubric'),
      text: `<p>Every item of the rubric now has a <b>suggested</b> score, with the evidence it is based on.
        Suggestions never decide by themselves: you do.</p>
        <p>Click <b>Accept the suggestions</b> (above the rubric): it fills in only the items that you did
        not decide yet. Then change what you disagree with.</p>`,
      done: decided,
      do_it: () => g.accept_suggestions(),
    },
    {
      title: 'The grade',
      target: () => $('grading-grade').parentElement,
      text: `<p>When all required items are met, the grade is the grade of the required items, plus the
        points of the extra items, up to a maximum; all extra items in full give the highest grade.</p>
        <p>When a required item is not met, the page does not compute a grade: you give it
        (<i>Give another grade</i>). The rubric, its items and its grades can be changed: see
        <i>The rubric</i> at the bottom of this tab.</p>`,
    },
    {
      title: 'Feedback',
      target: () => $('grading-comment'),
      text: `<p>Write a comment for the student here. The <b>standard comments</b> below it are inserted with
        one click (and can be changed). You can also add notes on lines of the programs, and pictures
        of the board as it is shown.</p>
        <p>Insert a standard comment, or type a comment.</p>`,
      done: () => Boolean(student() && student().comment.trim()),
      do_it: () => g.insert_snippet(g.rubric.snippets[0] || 'Well done.'),
    },
    {
      title: 'Feedback for this student',
      target: () => document.querySelector('#section-grading .grading-export'),
      text: `<p>The feedback (the grade, the items, your comment, notes and pictures) can be downloaded as a
        <b>PDF</b>, a web page or text; <i>Preview</i> shows it first. <i>Copy as text</i> copies it,
        to paste into a comment in Canvas.</p>`,
    },
    {
      title: 'Done with this student',
      target: () => $('grading-status'),
      text: `<p>Set the status of this student to <b>done</b> (at the top, next to the name). The list shows
        who is done; ▶ goes on to the next student.</p>`,
      done: () => Boolean(student() && student().status === 'done'),
      do_it: () => {
        $('grading-status').value = 'done';
        $('grading-status').dispatchEvent(new Event('change'));
      },
    },
    {
      title: 'All students at once',
      target: () => $('grading-batch'),
      enter: () => {
        $('grading-batch').closest('details').open = true;
      },
      text: `<p><b>Download all feedback (.zip)</b> gives the feedback of every student, and
        <code>grades.csv</code> with all grades and scores (also on its own: <i>Download the grades</i>).
        <i>Compare all submissions</i> lists the games that are most alike.</p>
        <p><code>grades.csv</code> is a table for a spreadsheet, not a file that Canvas can import: enter the
        grades in Canvas yourself, and give each student their feedback file (or the copied text) as a
        comment on their submission.</p>`,
    },
    {
      title: 'Keep and share the grading',
      target: () => document.querySelector('button[data-action=grading_export]').parentElement,
      text: `<p>Your grading (with the names of the students, their grades and PDF files) is kept in this
        browser. <b>Export the grading</b> gives a file, to keep it safe or to share the work with other
        graders; they use <b>Import grading…</b> (of a student graded by both, the version that was
        changed last is kept). <b>Remove all students</b> removes everything from this browser.</p>
        <p>On the command line, <code>logic-game grade submissions.zip</code> tests all submissions at once,
        and writes a grading file to import here; then load the same zip file with
        <i>Load submissions</i>, for the PDF files.</p>`,
    },
    {
      title: 'Done!',
      text: `<p>That is all. When you close the tutorial, the sample is removed and your own grading comes back.</p>
        <p>The tutorial can be started again from the top of the Grading tab. The full guide, with
        what to do in Canvas, is in the README of the project (<i>Grading, step by step</i>).</p>`,
      next: 'Close',
    },
  ];
}
