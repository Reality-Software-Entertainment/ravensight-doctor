class Match {
    void finish(java.util.List<String> players) {
        players.forEach(p -> capture("java_lambda"));
        Runnable r = () -> capture("java_runnable");
        this.client.capture("java_member");
    }
}
