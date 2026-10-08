import test from 'node:test';
import assert from 'node:assert/strict';
import { adjacentReadingChapter, chapterTitleForReader, readerBlocksForChapter } from '../src/core/reader-content.js';
import type { BookChapter } from '../src/core/types.js';

test('matching opening text is preserved instead of being deleted or replaced with a generated title', () => {
  const chapter: BookChapter = { title: '1', paragraphs: ['1', 'Opening prose.'] };
  assert.equal(chapterTitleForReader(chapter, 1), null);
  const blocks = readerBlocksForChapter(chapter.paragraphs, undefined);
  assert.deepEqual(blocks.filter((block) => block.type === 'paragraph').map((block) => block.paragraphIndex), [0, 1]);
  assert.equal(chapterTitleForReader({ title: 'Navigation label', paragraphs: ['Opening prose.'] }, 2), 'Navigation label');
  assert.equal(chapterTitleForReader({ title: 'Chapter', paragraphs: [] }, 2), 'Chapter 2');
});

test('reader rejects divergent rich text projections before they can corrupt NLP offsets', () => {
  assert.throws(() => readerBlocksForChapter(['Canonical text.'], [{ type: 'paragraph', paragraphIndex: 0, blockType: 'paragraph', content: [{ type: 'text', text: 'Different text.', marks: [] }] }]), /does not match its analysis paragraph/);
});

test('supplementary chapters remain accessible without entering the normal reading sequence', () => {
  const chapters: BookChapter[] = [{ title: 'First', paragraphs: ['One.'] }, { title: 'Second', paragraphs: ['Two.'] }, { title: 'Notes', paragraphs: ['A note.'], linear: false }];
  assert.equal(adjacentReadingChapter(chapters, 1, 1), 2);
  assert.equal(adjacentReadingChapter(chapters, 2, 1), 2);
  assert.equal(adjacentReadingChapter(chapters, 3, -1), 2);
});
