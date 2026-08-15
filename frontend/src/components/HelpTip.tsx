import QuestionCircleOutlined from '@ant-design/icons/QuestionCircleOutlined';
import { Tooltip } from 'antd';

export function HelpTip({ text }: { text: string }) {
  return (
    <Tooltip title={text} overlayInnerStyle={{ whiteSpace: 'pre-wrap', maxWidth: 360 }}>
      <QuestionCircleOutlined
        aria-label="帮助"
        style={{ color: 'rgba(0, 0, 0, 0.45)', cursor: 'help', marginLeft: 4 }}
      />
    </Tooltip>
  );
}

export function HelpLabel({ label, text }: { label: string; text: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {label}
      <HelpTip text={text} />
    </span>
  );
}
