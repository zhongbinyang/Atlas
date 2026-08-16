import { Form, Input, Modal, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { HelpLabel } from '../components/HelpTip';
import { SPEC_HELP } from './specHelp';

export type SaveAsSpecValues = {
  name: string;
  product_pn: string;
  note: string;
};

type SaveAsSpecModalProps = {
  open: boolean;
  confirmLoading?: boolean;
  sourceName?: string;
  initial: SaveAsSpecValues;
  onCancel: () => void;
  onSubmit: (values: SaveAsSpecValues) => void;
};

export function SaveAsSpecModal({
  open,
  confirmLoading,
  sourceName,
  initial,
  onCancel,
  onSubmit,
}: SaveAsSpecModalProps) {
  const [name, setName] = useState(initial.name);
  const [productPn, setProductPn] = useState(initial.product_pn);
  const [note, setNote] = useState(initial.note);

  useEffect(() => {
    if (!open) return;
    setName(initial.name);
    setProductPn(initial.product_pn);
    setNote(initial.note);
  }, [open, initial.name, initial.note, initial.product_pn]);

  return (
    <Modal
      title={<HelpLabel label="另存为 Spec 模板" text={SPEC_HELP.saveAs} />}
      open={open}
      onCancel={onCancel}
      onOk={() =>
        onSubmit({
          name: name.trim(),
          product_pn: productPn.trim(),
          note: note.trim(),
        })
      }
      okText="另存为"
      cancelText="取消"
      confirmLoading={confirmLoading}
      destroyOnClose
    >
      {sourceName ? (
        <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>
          将新建一份模板，不会覆盖当前「{sourceName}」。要覆盖请用「保存」。
        </Typography.Paragraph>
      ) : null}
      <Form layout="vertical" style={{ marginTop: 8 }}>
        <Form.Item label="名称" required>
          <Input
            autoFocus
            maxLength={128}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Form.Item>
        <Form.Item label="产品 PN">
          <Input
            value={productPn}
            onChange={(event) => setProductPn(event.target.value)}
          />
        </Form.Item>
        <Form.Item label="备注" style={{ marginBottom: 0 }}>
          <Input
            placeholder="可选"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
