# feature and bug

## bug
### markdown展示存在问题
llm返回的内容在前端展示的时候，并没有渲染成为markdown格式。

### UI界面的滑动较丑（暂时不要修正）
document.querySelector("#root > div > main > div > div") 其中html里面class=conversation-messages对话框里面的滚轮不是挺好看


### error状态的agent，无论发送什么消息，立马的回复就是Unexpected server error. Check server logs for details.
不知道是单个agent这样，还是所有都这样；数据库中session_id=ee471c26-4518-4cff-9ee0-a7c111ffcd07的就是这样

## feature
### 输入query之后，在响应回复第一个流来之前，显示一个正在处理的标识
eg: ......等等

### 模型的切换
v1版本页面无法选择对应的模型来切换。查看各个agent是否存在相应的SDK能够查询model，然后在前面让用户切换

### /command命令 以及 ! shell_command命令无法执行
目前排查是claude code、opencode、 pi agent的SDK支持问题。探讨是否存在解决方案

### 记录最后的报错信息
项目session与agent session关联表是data/sessions.db中的session表
目前对于某个agent报错之后，并没有记录上次报错的内容（仅记录上一次报错内容即可，之后报错进行覆盖即可）