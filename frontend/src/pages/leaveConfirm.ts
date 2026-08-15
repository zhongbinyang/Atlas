type ConfirmFn = (config: {
  title: string;
  content: string;
  okText: string;
  cancelText: string;
  onOk: () => void;
}) => void;

export function runOrConfirmUnsaved(confirm: ConfirmFn, dirty: boolean, action: () => void) {
  if (!dirty) {
    action();
    return;
  }
  confirm({
    title: '有未保存的修改',
    content: '离开将丢失未保存的修改，确定离开？',
    okText: '离开',
    cancelText: '留下',
    onOk: action,
  });
}
