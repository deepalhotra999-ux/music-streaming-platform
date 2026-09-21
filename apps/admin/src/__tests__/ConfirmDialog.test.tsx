// Phase 16 — ConfirmDialog tests: destructive actions fire only on
// explicit confirmation. Cancel, backdrop click, and Escape never fire.

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { ConfirmDialog, useConfirm } from '../components/ConfirmDialog';

describe('ConfirmDialog', () => {
  const baseProps = {
    open: true,
    title: 'Delete album?',
    message: 'This album will be permanently removed.',
  };

  it('renders nothing when closed', () => {
    const { container } = render(
      <ConfirmDialog {...baseProps} open={false} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('calls onConfirm only when the confirm button is clicked', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        {...baseProps}
        confirmLabel="Delete it"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'This album will be permanently removed.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete it' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancel does not fire the action', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        {...baseProps}
        confirmLabel="Delete it"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('backdrop click and Escape cancel without firing', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        {...baseProps}
        confirmLabel="Delete it"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByTestId('confirm-dialog-backdrop'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('useConfirm', () => {
  function Harness({ onDecision }: { onDecision: (ok: boolean) => void }) {
    const { confirm, dialog } = useConfirm();
    const [outcome, setOutcome] = useState('pending');
    return (
      <div>
        <button
          type="button"
          onClick={() =>
            void confirm({ title: 'Sure?', message: 'Really do it?' }).then((ok) => {
              onDecision(ok);
              setOutcome(ok ? 'confirmed' : 'cancelled');
            })
          }
        >
          Do the thing
        </button>
        <span data-testid="outcome">{outcome}</span>
        {dialog}
      </div>
    );
  }

  it('resolves false on cancel and true on explicit confirm', async () => {
    const onDecision = vi.fn();
    render(<Harness onDecision={onDecision} />);

    fireEvent.click(screen.getByRole('button', { name: 'Do the thing' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByTestId('outcome')).toHaveTextContent('cancelled');
    expect(onDecision).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getByRole('button', { name: 'Do the thing' }));
    const dialog2 = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog2).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByTestId('outcome')).toHaveTextContent('confirmed');
    expect(onDecision).toHaveBeenCalledWith(true);
  });
});
