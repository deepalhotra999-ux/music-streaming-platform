// Phase 31 — ReportDialog accessibility structure tests.
//
// The dismiss backdrop and the modal sheet must be siblings: nesting the
// sheet inside the backdrop button puts interactive controls inside a
// button in the accessibility tree.

import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { ReportDialog } from '../ReportDialog';

function renderDialog(overrides = {}) {
  return render(
    <ReportDialog
      visible
      targetLabel="this post"
      submitting={false}
      error={null}
      onSubmit={jest.fn()}
      onClose={jest.fn()}
      testID="report-dialog"
      {...overrides}
    />,
  );
}

describe('ReportDialog accessibility', () => {
  it('exposes a labelled dismiss control separate from the modal sheet', () => {
    renderDialog();
    const dismiss = screen.UNSAFE_getByProps({ accessibilityLabel: 'Dismiss report dialog' });
    expect(dismiss.props.accessibilityRole).toBe('button');
    // The sheet is the modal; it must not be nested inside the button.
    const sheet = screen.getByTestId('report-dialog');
    expect(sheet.props.accessibilityViewIsModal).toBe(true);
    expect(within(dismiss).queryByTestId('report-dialog')).toBeNull();
  });

  it('dismisses via the backdrop button', () => {
    const onClose = jest.fn();
    renderDialog({ onClose });
    fireEvent.press(screen.UNSAFE_getByProps({ accessibilityLabel: 'Dismiss report dialog' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('announces submission errors as an alert', () => {
    renderDialog({ error: 'Something went wrong' });
    const alert = screen.getByText('Something went wrong');
    expect(alert.props.accessibilityRole).toBe('alert');
    expect(alert.props.accessibilityLiveRegion).toBe('assertive');
  });

  it('labels the submit button with its target context', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Send report for this post' })).toBeTruthy();
  });
});
