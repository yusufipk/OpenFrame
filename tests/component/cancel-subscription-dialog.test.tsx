import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CancelSubscriptionDialog } from '@/components/settings/cancel-subscription-dialog';

function renderDialog(
  overrides: { periodEnd?: string | null; isTrial?: boolean; confirmResult?: boolean } = {}
) {
  const onConfirm = vi.fn(async () => overrides.confirmResult ?? true);
  const onOpenChange = vi.fn();
  render(
    <CancelSubscriptionDialog
      open
      onOpenChange={onOpenChange}
      periodEnd={
        overrides.periodEnd === undefined ? '2026-10-01T00:00:00.000Z' : overrides.periodEnd
      }
      isTrial={overrides.isTrial ?? false}
      onConfirm={onConfirm}
    />
  );
  return { onConfirm, onOpenChange };
}

describe('CancelSubscriptionDialog', () => {
  it('lists every answer with none selected', () => {
    renderDialog();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(5);
    for (const radio of radios) {
      expect(radio).toHaveAttribute('aria-checked', 'false');
    }
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  // The question is skippable: the destructive button works with nothing
  // chosen, and the handler receives an explicit null rather than a default.
  it('cancels with no reason when the question is skipped', async () => {
    const { onConfirm } = renderDialog();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));

    expect(onConfirm).toHaveBeenCalledWith({ reason: null, note: null });
  });

  it('opens the note box only under the answers that ask for detail', async () => {
    renderDialog();

    await userEvent.click(screen.getByRole('radio', { name: 'I am not using it enough' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'Something else' }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: 'It is missing something I need' }));
    expect(screen.getByLabelText(/What was missing\?/)).toBeInTheDocument();
  });

  it('sends the chosen reason with a trimmed note', async () => {
    const { onConfirm } = renderDialog();

    await userEvent.click(screen.getByRole('radio', { name: 'Something else' }));
    await userEvent.type(screen.getByRole('textbox'), '  Moved the client to Frame.io  ');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));

    expect(onConfirm).toHaveBeenCalledWith({
      reason: 'OTHER',
      note: 'Moved the client to Frame.io',
    });
  });

  // A note typed under "Something else" must not travel with an answer that
  // never showed the box, or the admin reads a comment about nothing.
  it('drops the note when the answer changes to one without a note box', async () => {
    const { onConfirm } = renderDialog();

    await userEvent.click(screen.getByRole('radio', { name: 'Something else' }));
    await userEvent.type(screen.getByRole('textbox'), 'Some detail');
    await userEvent.click(screen.getByRole('radio', { name: 'The project or client work ended' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));

    expect(onConfirm).toHaveBeenCalledWith({ reason: 'PROJECT_ENDED', note: null });
  });

  // A failed request must not cost the customer the answer they typed.
  it('keeps the answer on screen when the confirmation fails', async () => {
    const { onConfirm } = renderDialog({ confirmResult: false });

    await userEvent.click(screen.getByRole('radio', { name: 'Something else' }));
    await userEvent.type(screen.getByRole('textbox'), 'Kept this');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel subscription' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radio', { name: 'Something else' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('textbox')).toHaveValue('Kept this');
  });

  it('closes without confirming from the keep button', async () => {
    const { onConfirm, onOpenChange } = renderDialog();

    await userEvent.click(screen.getByRole('button', { name: 'Keep subscription' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('names the trial instead of the subscription while still trialing', () => {
    renderDialog({ isTrial: true });

    expect(screen.getByRole('heading', { name: 'Cancel your trial?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel trial' })).toBeInTheDocument();
  });
});
