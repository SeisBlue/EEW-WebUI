docker run -it --rm \
-v ${PWD}:/workspace \
-w /workspace \
--network eew-web_default \
seisblue/ttsam-realtime \
python $@