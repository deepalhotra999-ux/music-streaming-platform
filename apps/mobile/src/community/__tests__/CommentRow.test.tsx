// Phase 29 — CommentRow and ReportDialog tests.

import { fireEvent, render, screen } from '@testing-library/react-native';
import type { PostComment } from '../../api';
import { CommentRow } from '../components/CommentRow';
import { ReportDialog } from '../components/ReportDialog';

function makeComment(overrides: Partial<PostComment> = {}): PostComment {
  return {
    id: 'comment-1',
    postId: 'post-1',
    body: 'Love this!',
    author: { id: 'user-2', displayName: 'Fan', avatarUrl: null },
    status: 'ACTIVE',
    createdAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
    ...overrides,
  };
}

describe('CommentRow', () => {
  it('renders the author name and body', () => {
    render(<CommentRow comment={makeComment()} isOwn={false} testID="row" />);
    expect(screen.getByText('Fan')).toBeTruthy();
    expect(screen.getByText('Love this!')).toBeTruthy();
  });

  it('shows delete for the own comment and report for others', () => {
    const onDelete = jest.fn();
    const onReport = jest.fn();
    render(
      <CommentRow
        comment={makeComment()}
        isOwn={true}
        onDelete={onDelete}
        onReport={onReport}
        testID="row"
      />,
    );
    expect(screen.queryByTestId('row-delete')).toBeTruthy();
    expect(screen.queryByTestId('row-report')).toBeNull();
    fireEvent.press(screen.getByTestId('row-delete'));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'comment-1' }));
  });

  it('shows report (not delete) for other users comments', () => {
    const onReport = jest.fn();
    render(<CommentRow comment={makeComment()} isOwn={false} onReport={onReport} testID="row" />);
    expect(screen.queryByTestId('row-report')).toBeTruthy();
    fireEvent.press(screen.getByTestId('row-report'));
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({ id: 'comment-1' }));
  });
});

describe('ReportDialog', () => {
  const base = {
    visible: true,
    targetLabel: 'this post',
    submitting: false,
    error: null as string | null,
    onSubmit: jest.fn(),
    onClose: jest.fn(),
    testID: 'report',
  };

  it('requires at least 3 characters before submitting', () => {
    const onSubmit = jest.fn();
    render(<ReportDialog {...base} onSubmit={onSubmit} />);
    const submit = screen.getByTestId('report-submit');
    expect(submit.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.changeText(screen.getByTestId('report-reason'), 'Spam');
    expect(screen.getByTestId('report-submit').props.accessibilityState).toMatchObject({
      disabled: false,
    });
    fireEvent.press(screen.getByTestId('report-submit'));
    expect(onSubmit).toHaveBeenCalledWith('Spam');
  });

  it('shows server errors and blocks input while submitting', () => {
    render(<ReportDialog {...base} submitting={true} error="Rate limited" />);
    expect(screen.getByText('Rate limited')).toBeTruthy();
    expect(screen.getByTestId('report-reason').props.editable).toBe(false);
  });
});
