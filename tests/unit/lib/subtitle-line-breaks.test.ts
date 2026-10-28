import { describe, it, expect } from 'vitest';
import { balanceCueLines } from '@/lib/subtitle-line-breaks';

describe('balanceCueLines', () => {
  it('leaves a cue that already fits on one line untouched', () => {
    expect(balanceCueLines('A test is a small program.')).toBe('A test is a small program.');
    // Exactly 42 characters is still one line.
    expect(balanceCueLines('abcdefghij abcdefghij abcdefghij abcdefghi')).toBe(
      'abcdefghij abcdefghij abcdefghij abcdefghi'
    );
  });

  it('splits a long sentence into two lines of about the same length', () => {
    expect(balanceCueLines('A test is a small program that checks the code works.')).toBe(
      'A test is a small program\nthat checks the code works.'
    );
  });

  // The cue from the bug report: 91 characters, too long for two lines of 42.
  it('goes to three lines when two would not fit', () => {
    expect(
      balanceCueLines(
        'test. A test is a small program that automatically checks whether the code works correctly.'
      )
    ).toBe(
      'test. A test is a small program\nthat automatically checks whether\nthe code works correctly.'
    );
  });

  it('splits seventeen words into three lines within the limit', () => {
    const text =
      'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen';
    const result = balanceCueLines(text);
    expect(result).toBe(
      'one two three four five six seven\neight nine ten eleven twelve thirteen\nfourteen fifteen sixteen seventeen'
    );
  });

  it('keeps a line break the author already put in', () => {
    const text = 'This first line is already rather long on its own\nand so is this one';
    expect(balanceCueLines(text)).toBe(text);
  });

  it('does not count or split markup', () => {
    expect(balanceCueLines('<v Jane Doe>Short line with a voice tag</v>')).toBe(
      '<v Jane Doe>Short line with a voice tag</v>'
    );
    expect(
      balanceCueLines('<v Jane Doe>This sentence is long enough that it has to wrap somewhere</v>')
    ).toBe('<v Jane Doe>This sentence is long enough\nthat it has to wrap somewhere</v>');
  });

  it('leaves a single long word alone, since there is nowhere to break it', () => {
    const word = 'a'.repeat(60);
    expect(balanceCueLines(word)).toBe(word);
  });

  it('puts each word on its own line when even that is over the limit', () => {
    const long = 'a'.repeat(50);
    const longer = 'b'.repeat(60);
    expect(balanceCueLines(`${long} ${longer}`)).toBe(`${long}\n${longer}`);
  });

  // 15 characters with a limit of 7 fits on two lines once the middle space is a break.
  it('does not count the space a break replaces', () => {
    expect(balanceCueLines('aaa bbb ccc ddd', 7)).toBe('aaa bbb\nccc ddd');
  });

  // The limit gives "a bbbbbbbbbbb" no room, so the long word ends up alone.
  it('gives a word that only fits alone a line of its own', () => {
    expect(balanceCueLines('a bbbbbbbbbbb c', 11)).toBe('a\nbbbbbbbbbbb\nc');
  });

  // Placing each break at the nearest even share of the text gave this cue four lines.
  it('never uses more lines than the limit needs', () => {
    expect(
      balanceCueLines(
        'xxxxxxxxx xxxxxxxxxxxx xxxxxx xxxxxxxxxxxx xxxxxxxxxx xx xxxxxx x xxxxxxx xxxxxxxxxx xxx xxxxxxxxxxx xxxx'
      )
    ).toBe(
      'xxxxxxxxx xxxxxxxxxxxx xxxxxx\nxxxxxxxxxxxx xxxxxxxxxx xx xxxxxx x\nxxxxxxx xxxxxxxxxx xxx xxxxxxxxxxx xxxx'
    );
  });

  // A URL or a path is often longer than the limit. It gets a line to itself, and the
  // other lines still keep to the limit rather than stretching to its width.
  it('keeps the other lines within the limit around a word longer than it', () => {
    const long = 'x'.repeat(50);
    expect(
      balanceCueLines(`${long} aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa`)
    ).toBe(`${long}\naa aa aa aa aa aa aa aa aa aa\naa aa aa aa aa aa aa aa aa aa`);
  });

  // Filling greedily gave 34, 32 and 22 characters; 34, 27 and 27 is the even split.
  it('evens out the lines instead of leaving a short tail', () => {
    expect(
      balanceCueLines(
        'and that is exactly why we decided to rebuild the whole player from scratch this year, yes'
      )
    ).toBe(
      'and that is exactly why we decided\nto rebuild the whole player\nfrom scratch this year, yes'
    );
  });

  // 15 two-letter words are 30 letters but 44 characters once the spaces count.
  it('counts the spaces between words toward the limit', () => {
    expect(balanceCueLines('aa aa aa aa aa aa aa aa aa aa aa aa aa aa aa')).toBe(
      'aa aa aa aa aa aa aa aa\naa aa aa aa aa aa aa'
    );
  });

  it('breaks at a tab as it does at a space', () => {
    expect(balanceCueLines('aaa\tbbb ccc ddd', 7)).toBe('aaa bbb\nccc ddd');
  });

  it('counts an emoji as one character', () => {
    // 41 characters on screen, but 42 UTF-16 code units.
    const text = `${'a'.repeat(19)} ${'b'.repeat(19)} \u{1F600}`;
    expect(balanceCueLines(text, 41)).toBe(text);
  });

  it('does not leave a tag on a line of its own', () => {
    expect(balanceCueLines('<i>aaaa bbbb </i>', 4)).toBe('<i>aaaa\nbbbb</i>');
    expect(balanceCueLines('<i> aaaaaaa bbbbbbb', 7)).toBe('<i>aaaaaaa\nbbbbbbb');
  });

  // Around an oversized word the even split needs a line that is wider than the others.
  it('evens out the lines that follow a word longer than the limit', () => {
    const long = 'x'.repeat(50);
    expect(
      balanceCueLines(
        `${long} and that is exactly why we decided to rebuild the whole player from scratch this year, yes`
      )
    ).toBe(
      `${long}\nand that is exactly why we decided\nto rebuild the whole player\nfrom scratch this year, yes`
    );
  });

  it('collapses repeated and edge spaces when it splits', () => {
    expect(balanceCueLines('  A test is a small   program that checks the code works.  ')).toBe(
      'A test is a small program\nthat checks the code works.'
    );
  });

  it('does not break at a no-break space', () => {
    expect(balanceCueLines('The file is exactly ten\u00a0km long and that is far too long')).toBe(
      'The file is exactly ten\u00a0km\nlong and that is far too long'
    );
  });

  it('counts a character reference as the one character it shows', () => {
    // 34 characters on screen against 50 in the file: one line.
    const fits = 'Tom &amp; Jerry &amp; Spike &amp; Tyke &amp; Butch';
    expect(balanceCueLines(fits)).toBe(fits);
    // 43 on screen, so the ampersand has to count as one for this to split.
    expect(balanceCueLines('Salt &amp; pepper are on the table right now ok', 42)).toBe(
      'Salt &amp; pepper are on\nthe table right now ok'
    );
  });

  it('can break inside an italic span, which the cue parser carries across lines', () => {
    expect(
      balanceCueLines('<i>This sentence is long enough that it has to wrap somewhere</i>')
    ).toBe('<i>This sentence is long enough\nthat it has to wrap somewhere</i>');
  });

  it('leaves its own output unchanged when run again', () => {
    const once = balanceCueLines(
      'test. A test is a small program that automatically checks whether the code works correctly.'
    );
    expect(balanceCueLines(once)).toBe(once);
  });
});
