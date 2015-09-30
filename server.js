var fs       = require("fs");
var http     = require('http');
var socketio = require("socket.io")
var midi     = require('midi');
var dgram    = require("dgram");
var osc      = require('osc-min');

var LISTEN_PORT = 8080;

oscSender = dgram.createSocket("udp4")

//==============================================================================
// 汎用関数
//==============================================================================
function convert_message(msg, msg_from, msg_to){
  if(msg_from == msg_to) return msg; // そのまま

  if(msg_from == "json"){
    if(msg_to == "osc" ) return osc.toBuffer(msg);
    if(msg_to == "midi") return msg;
  }
  if(msg_from == "osc"){
    if(msg_to == "json") return osc.fromBuffer(msg); // throw
    if(msg_to == "midi") return msg;
  }
  if(msg_from == "midi"){
    if(msg_to == "json") return msg;
    if(msg_to == "osc" ) return msg;
  }
}

//==============================================================================
// 全体の管理情報
//==============================================================================
function ClientJson(/*direction,*/ socketId){
  return {
    type:      "json",
    socketId:  socketId,

    deliver: function(msg, msg_from){
      io.to(this.socketId).emit("message_json", convert_message(msg, msg_from, "json"));
    },

    simplify: function(){ return {type: "json", socketId: this.socketId} },
  };
}

function ClientOsc(/*direction,*/ host, port){
  return {
    type:      "osc",
    host:      host, // 受信時には使わない
    port:      port,

    deliver: function(msg, msg_from){
      var buf = convert_message(msg, msg_from, "osc")
      console.log("*********")
      console.log(buf)
      console.log(buf.length)
      console.log(this.port, this.host)
      oscSender.send(buf, 0, buf.length, this.port, this.host);
    },

    simplify: function(){ return {type: "osc", host: this.host, port: this.port} },
  }
}

function ClientMidi(/*direction,*/ portNum, name){
  return {
    type:      "midi",
    portNum:   portNum,
    name:      name,


    deliver: function(msg, msg_from){
      var buf = convert_message(msg, msg_from, "midi")
      console.log("midi out", buf)
      midiObj.outputs[this.portNum].sendMessage(buf);
    },

    simplify: function(){ return {type: "midi", portNum: this.portNum, name: this.name} },
  };
}

//==============================================================================
// データ全体
//==============================================================================
var self = {
  clients_input:  {},
  clients_output: {},
  id_input:      0,
  id_output:     0, // 接続のユニークID

  //==============================================================================
  // クライアント管理
  //==============================================================================
  addNewClientInput: function(client){
    this.clients_input[this.id_input] = client;
    this.id_input += 1;
    return this.id_input - 1;
  },

  addNewClientOutput: function(client){
    this.clients_output[this.id_output] = client;
    this.id_output += 1;
    return this.id_output - 1;
  },

  deleteClientInput: function(clientId){
    delete this.clients_input[clientId];
    return;
  },

  deleteClientOutput: function(clientId){
    delete this.clients_output[clientId];
    return;
  },

  //==============================================================================
  // コネクション管理
  //==============================================================================
  connections: {}, // {input_clientId: [output_clientId, ...]}
  oscsocks:    {}, // {input_oscport: {clientId: , sock: }} osc送受信オブジェクトを詰めておくところ
  // socketはio.socketsで参照可能

  addConnection: function(input_clientId, output_clientId){
    // まず結線情報を作る
    if (this.connections[input_clientId]){
      if (this.connections[input_clientId].indexOf(output_clientId) < 0){
        this.connections[input_clientId].push(output_clientId);
      }
    } else {
      this.connections[input_clientId] = [output_clientId];
    }

    // midiポートはopenする
  },

  deleteConnection: function(input_clientId, output_clientId){
    // まず結線情報を作る
    if (this.connections[input_clientId]){
      var pos = this.connections[input_clientId].indexOf(output_clientId);
      if (pos >= 0){
        this.connections[input_clientId].splice(pos);
      }
    } else {
      // 何もしない
    }

    //
  },

  //==============================================================================
  // データ送信管理
  //==============================================================================
  socketId2clientId: function(socketId, clients){
    // socketのcallbackで届いてきたメッセージの送信元を調べる
    for (var k in clients) {
      var client = clients[k];
      if(client.type == "json" && client.socketId == socketId){
        return k;
      }
    }
    return -1;
  },

}


//==============================================================================
// WebSocketの設定
//==============================================================================

// 普通のhttpサーバーとしてlisten
var server = http.createServer(function(req, res) {
  res.writeHead(200, {"Content-Type":"text/html"});
  var output = fs.readFileSync("./index.html", "utf-8"); // カレントディレクトリのindex.htmlを配布
  res.end(output);
}).listen(LISTEN_PORT);

// websocketとしてlistenして、応答内容を記述
var io = socketio.listen(server);
io.sockets.on("connection", function (socket) {
  // (1) ただweb設定画面を見に来た人と、
  // (2) WebSocket-JSON (以下wsjson) でネットワークに参加しにきた人と、
  // (3) OSCでネットワークに参加しにきた人は別扱いする必要がある

  // (1)のためのAPI
  //  - ネットワーク接続者一覧を表示する(socketだからサーバー側からpush可能)
  function update_list(){
    // メソッド類は削ぎ落として表示に必要な情報だけまとめる
    var inputs  = {}; for (i in self.clients_input ) inputs [i] = self.clients_input [i].simplify();
    var outputs = {}; for (o in self.clients_output) outputs[o] = self.clients_output[o].simplify();

    // broadcast all clients (including the sender)
    io.sockets.emit("update_list", {inputs: inputs, outputs: outputs, connections: self.connections});
  }
  update_list(); // websocket接続時に一度現状を送る

  //  - ネットワークのノード間の接続/切断をする
  socket.on("add_connection", function (obj) {
    var inputId = obj.inputId, outputId = obj.outputId, connect = obj.connect

    if (connect == true){
      self.addConnection(inputId, outputId) // 接続
      console.log("input '" + inputId + "' connected to output '" + outputId + "'");
    } else {
      self.deleteConnection(inputId, outputId) // 切断
      console.log("input '" + inputId + "' and output '" + outputId + "' disconnected");
    }

    update_list(); // ネットワーク更新
  });

  // (2)のためのAPIは、(1)に加えて
  //  - wsjsonクライアントとしてネットワークに参加する
  socket.on("join_as_wsjson", function () {
    var inputId  = self.addNewClientInput (ClientJson(socket.id));
    var outputId = self.addNewClientOutput(ClientJson(socket.id));

    console.log("[Web Socket #'" + socket.id + "'] joined as JSON client");

    //  - メッセージを受信する
    socket.on("message_json", function (obj) {
      var inputId  = self.socketId2clientId(socket.id, self.clients_input);

      console.log("message from input #" + inputId);

      if (inputId >= 0) {
        var client = self.clients_input[inputId];
        for(var o in self.connections[inputId]){
          var outputId = self.connections[inputId][o]
          var output   = self.clients_output[outputId];
          output.deliver(obj, "json");
        }
      }
    });

    update_list(); // ネットワーク更新
  });

  //  - ネットワークから離脱する
  socket.on("exit_wsjson", function () {
    self.deleteClientInput (self.socketId2clientId(socket.id, self.clients_input ));
    self.deleteClientOutput(self.socketId2clientId(socket.id, self.clients_output));

    console.log("[Web Socket #'" + socket.id + "'] exited.");

    update_list(); // ネットワーク更新
  });

  // が必要。これらを関数化したjavascriptを配布する必要があるかも

  // (3)のためのAPIは、(1)に加えて
  //  - 指定のアドレス/ポート番号をoscクライアントとしてネットワークに追加する
  socket.on("join_as_osc", function (obj) {
    var inPort = 12345; // 受信ポートは指定が無ければサーバーが独自に決める

    // 入り口と出口のudpポートを作成する
    var _onRead = function(inputId){
      return function(msg, rinfo) {
        console.log("message from input #" + inputId);

        // var obj;
        // try {
        //   obj = osc.fromBuffer(msg);
        // } catch (_error) {
        //   return console.log("invalid OSC packet");
        // }

        for(var o in self.connections[inputId]){
          var outputId = self.connections[inputId][o]
          var output   = self.clients_output[outputId];
          output.deliver(msg, "osc");
        }

      }
    }

    // socketのlistenに成功してからネットワークに登録したいので、idは先回りで受け取る
    self.oscsocks[inPort] = dgram.createSocket("udp4", _onRead(self.id_input));
    self.oscsocks[inPort].bind(inPort);

    // 接続ネットワークに参加する
    var inputId  = self.addNewClientInput (ClientOsc(obj.host, inPort));
    var outputId = self.addNewClientOutput(ClientOsc(obj.host, obj.port));

    console.log("[OSC #'" + obj.host + "'] joined as OSC client");

    update_list(); // クライアントのネットワーク表示更新
  });
  //  - 指定のアドレス/ポート番号のoscクライアントをネットワークから除外する
  // が必要。oscアプリ本体とこのserver.jsのoscモジュールが直接メッセージをやり取りするので、
  // oscクライアントとの実通信にWebSocketは絡まない。あくまでコネクション管理のみ

  // 接続開始
  // socket.on("connected", function (obj) {
  //   console.log("client '" + obj.name + "' connected.");
  //   devices.clients[socket.id] = Client(socket, obj.name)
  // });
  //
  // socket.on("publish", function (obj) {
  //   // broadcast all clients (including the sender)
  //   io.sockets.emit("publish", obj);
  // });

  // 接続終了
  socket.on("disconnect", function () {
    // if (devices.clients[socket.id]) {
    //   console.log("client '" + devices.clients[socket.id].name + "' disconnected.");
    //   delete devices.clients[socket.id];
    // }
  });

});

console.log("listening connections...")

//==============================================================================
// MIDIの設定
//==============================================================================

// Set up a new input.
var midiObj = {
  input:  new midi.input(),  // port一覧を出すためのglobalな(openPortしない)inputを一つ用意しておく
  output: new midi.output(), // port一覧を出すためのglobalな(openPortしない)outputを一つ用意しておく

  inputs : {}, // 開いたportにつながっているmidiオブジェクト
  outputs: {}, // 開いたportにつながっているmidiオブジェクト

  setup_midiports: function(){
    // inputをopen
    for(var portId=0; portId<this.input.getPortCount(); ++portId){
      console.log("input  ", portId, this.input.getPortName(portId));

      // ネットワークに登録
      var inputId  = self.addNewClientInput (ClientMidi(portId, this.input.getPortName(portId)));

      // コールバックを作る(inputIdをキャプチャする)
      var _onMessage = function(_inputId){
        return function(deltaTime, message) {
          // The message is an array of numbers corresponding to the MIDI bytes:
          //   [status, data1, data2]
          // https://www.cs.cf.ac.uk/Dave/Multimedia/node158.html has some helpful
          // information interpreting the messages.
          var msg = {'msg': message, 'delta': deltaTime};
          console.log(msg);

          // 転送
          for(var o in self.connections[_inputId]){
            var outputId = self.connections[_inputId][o]
            var output   = self.clients_output[outputId];
            output.deliver(message, "midi"); // とりあえずメッセージだけ送る
          }
        };
      }

      // 開く
      this.inputs[portId] = this.openInput(portId, _onMessage(inputId));
    }

    // outputをopen
    for(var portId=0; portId<this.output.getPortCount(); ++portId){
      console.log("output ", portId, this.output.getPortName(portId));

      // ネットワークに登録
      var outputId = self.addNewClientOutput(ClientMidi(portId, this.output.getPortName(portId)));

      // 開く
      this.outputs[portId] = new midi.output();
      this.outputs[portId].openPort(portId);
    }

    return;
  },

  openInput: function(port, callback){
    var this_input  = new midi.input();

    this_input.on('message', callback); // configure a callback.
    this_input.openPort(port);          // open port

    // Sysex, timing, and active sensing messages are ignored
    // by default. To enable these message types, pass false for
    // the appropriate type in the function below.
    // Order: (Sysex, Timing, Active Sensing)
    // For example if you want to receive only MIDI Clock beats
    // you should use
    // input.ignoreTypes(true, false, true)
    this_input.ignoreTypes(false, true, true);

    return this_input;
  }

}

midiObj.setup_midiports();
